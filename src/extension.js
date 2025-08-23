const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function activate(context) {
    const disposable = vscode.commands.registerCommand('salesforce-metadata-manager.openManager', () => {
        const panel = vscode.window.createWebviewPanel(
            'metadataManager',
            'Salesforce Metadata Manager',
            vscode.ViewColumn.One,
            { 
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        panel.webview.html = getWebviewContent();

        panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'getMetadataTypes':
                        handleGetMetadataTypes(panel);
                        break;
                    case 'getComponents':
                        handleGetComponents(panel, message.metadataType);
                        break;
                    case 'createPackage':
                        handleCreatePackage(message.components, panel);
                        break;
                    case 'loadExisting':
                        handleLoadExisting(panel);
                        break;
                }
            },
            undefined,
            context.subscriptions
        );

        setTimeout(() => {
            handleGetMetadataTypes(panel);
        }, 100);
        
        setTimeout(() => {
            handleLoadExisting(panel);
        }, 1000);
    });

    context.subscriptions.push(disposable);
}

async function handleGetMetadataTypes(panel) {
    try {
        const metadataTypes = await getMetadataTypesFromSalesforce();
        panel.webview.postMessage({
            command: 'metadataTypesLoaded',
            metadataTypes: metadataTypes
        });
    } catch (error) {
        panel.webview.postMessage({
            command: 'metadataTypesError',
            errorMessage: error
        });
    }
}

async function handleGetComponents(panel, metadataType) {
    try {
        const components = await getComponentsFromSalesforce(metadataType);
        panel.webview.postMessage({
            command: 'componentsLoaded',
            components: components
        });
    } catch (error) {
        vscode.window.showErrorMessage('Failed to fetch components: ' + error.message);
    }
}

async function handleCreatePackage(components, panel) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found');
        // Hide spinner on error
        panel.webview.postMessage({
            command: 'updateRetrievalStatus',
            results: [],
            errorMessage: 'No workspace folder found'
        });
        return;
    }

    const manifestDir = path.join(workspaceFolder.uri.fsPath, 'manifest');
    if (!fs.existsSync(manifestDir)) {
        fs.mkdirSync(manifestDir);
    }

    const packageXml = await generatePackageXml(components);
    const packagePath = path.join(manifestDir, 'package.xml');
    
    fs.writeFileSync(packagePath, packageXml);
    retrieveMetadata(workspaceFolder.uri.fsPath, components, panel);
}

function handleLoadExisting(panel) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const packagePath = path.join(workspaceFolder.uri.fsPath, 'manifest', 'package.xml');
    if (fs.existsSync(packagePath)) {
        const components = parseExistingPackage(packagePath);
        panel.webview.postMessage({
            command: 'loadExistingComponents',
            components: components
        });
    }
}

function parseExistingPackage(packagePath) {
    const content = fs.readFileSync(packagePath, 'utf8');
    const components = [];
    
    const typeRegex = /<types>([\s\S]*?)<\/types>/g;
    let typeMatch;
    
    while ((typeMatch = typeRegex.exec(content)) !== null) {
        const typeContent = typeMatch[1];
        const nameMatch = typeContent.match(/<name>(.*?)<\/name>/);
        const metadataType = nameMatch ? nameMatch[1] : '';
        
        const memberRegex = /<members>(.*?)<\/members>/g;
        let memberMatch;
        const members = [];
        
        // Collect all members for this type
        while ((memberMatch = memberRegex.exec(typeContent)) !== null) {
            members.push(memberMatch[1]);
        }
        
        // Filter out folders for Dashboard, Document, and EmailTemplate
        if (['Dashboard', 'Document', 'EmailTemplate'].includes(metadataType)) {
            members.forEach(member => {
                const memberWithSlash = member + '/';
                const isFolder = members.some(otherMember => 
                    otherMember !== member && otherMember.startsWith(memberWithSlash)
                );
                
                if (!isFolder) {
                    components.push({
                        name: member,
                        apiName: member,
                        type: metadataType
                    });
                }
            });
        } else {
            // For other metadata types, add all members
            members.forEach(member => {
                components.push({
                    name: member,
                    apiName: member,
                    type: metadataType
                });
            });
        }
    }
    
    return components;
}

function retrieveMetadata(workspacePath, components, panel) {
    exec('sf project retrieve start --manifest manifest/package.xml --ignore-conflicts --json',
        { cwd: workspacePath },
        (error, stdout, stderr) => {
            // If there's a command execution error, hide spinner and show error
            if (error) {
                // Try to parse stdout for error information first, since it contains structured error data
                let errorMessage = error.message || 'Retrieval failed';
                
                // Check stdout for structured error information
                if (stdout) {
                    try {
                        const stdoutResult = JSON.parse(stdout);
                        if (stdoutResult.status === 1 && stdoutResult.message) {
                            errorMessage = stdoutResult.message;
                        }
                    } catch (parseError) {
                        // Parsing failed, continue with other error sources
                    }
                }
                
                // If no stdout error, try stderr
                if (errorMessage === (error.message || 'Retrieval failed') && stderr) {
                    try {
                        const errorResult = JSON.parse(stderr);
                        errorMessage = errorResult.message || errorResult.error || stderr;
                    } catch (parseError) {
                        // If parsing fails, use stderr as the error message
                        if (stderr.trim()) {
                            errorMessage = stderr.trim();
                        }
                    }
                }
                
                // Treat 'Could not find HEAD' as success regardless of where the error message comes from
                if (errorMessage.includes('Metadata API request failed: Could not find HEAD.')) {
                    const results = components.map((comp, index) => ({
                        index: index,
                        status: 'Success'
                    }));
                    panel.webview.postMessage({
                        command: 'updateRetrievalStatus',
                        results: results,
                        errorMessage: null
                    });
                    return;
                }
                
                panel.webview.postMessage({
                    command: 'updateRetrievalStatus',
                    results: components.map((comp, index) => ({ index, status: 'Failed' })),
                    errorMessage: errorMessage
                });
                return;
            }
            const results = [];
            let errorMessage = null;
            let errorType = null; // 'command' or 'component'
            
            try {
                const result = JSON.parse(stdout || '{}');
                
                if (result.status === 1) {
                    // Command-level error (Type 1)
                    errorType = 'command';
                    errorMessage = result.message || 'Retrieval failed';
                    
                    // Treat 'Could not find HEAD' as success
                    if (errorMessage.includes('Metadata API request failed: Could not find HEAD.')) {
                        components.forEach((comp, index) => {
                            results.push({
                                index: index,
                                status: 'Success'
                            });
                        });
                        errorMessage = null;
                    } else {
                        components.forEach((comp, index) => {
                            results.push({
                                index: index,
                                status: 'Failed',
                                errorMessage: errorMessage
                            });
                        });
                    }
                } else if (result.status === 0) {
                    // Command successful, check individual components (Type 2)
                    const files = result.result?.files || [];
                    const failedFiles = files.filter(file => file.state === 'Failed');
                    
                    if (failedFiles.length > 0) {
                        errorType = 'component';
                        // Build component-specific error messages with bullets and spacing
                        const componentErrors = failedFiles.map(file =>
                            `• <strong>${file.fullName} (${file.type})</strong> - ${file.error || file.problem || 'Unknown error'}`
                        );
                        errorMessage = componentErrors.join('<br><br>');
                    }
                    
                    // Map component results
                    components.forEach((comp, index) => {
                        const failedFile = failedFiles.find(file => file.fullName === comp.apiName);
                        const errorMessage = failedFile ? (failedFile.error || failedFile.problem || 'Component retrieval failed') : null;
                        results.push({
                            index: index,
                            status: failedFile ? 'Failed' : 'Success',
                            errorMessage: errorMessage
                        });
                    });
                } else {
                    // Fallback for unknown status
                    components.forEach((comp, index) => {
                        results.push({
                            index: index,
                            status: 'Success'
                        });
                    });
                }
            } catch (e) {
                // JSON parsing failed, treat as command error
                errorType = 'command';
                // Try to get more specific error information
                if (stderr) {
                    try {
                        const errorResult = JSON.parse(stderr);
                        errorMessage = errorResult.message || errorResult.error || stderr;
                    } catch (parseError) {
                        // If parsing fails, use stderr as the error message
                        if (stderr.trim()) {
                            errorMessage = stderr.trim();
                        } else {
                            errorMessage = error?.message || 'Retrieval failed';
                        }
                    }
                } else {
                    errorMessage = error?.message || 'Retrieval failed';
                }
                
                // Treat 'Could not find HEAD' as success regardless of where the error message comes from
                if (errorMessage.includes('Metadata API request failed: Could not find HEAD.')) {
                    components.forEach((comp, index) => {
                        results.push({
                            index: index,
                            status: 'Success'
                        });
                    });
                    errorMessage = null;
                } else {
                    components.forEach((comp, index) => {
                        results.push({
                            index: index,
                            status: 'Failed',
                            errorMessage: errorMessage
                        });
                    });
                }
            }
            
            panel.webview.postMessage({
                command: 'updateRetrievalStatus',
                results: results,
                errorMessage: errorMessage,
                errorType: errorType
            });
        }
    );
}

async function generatePackageXml(components) {
    const apiVersion = await getLatestApiVersion();
    const groupedComponents = {};
    
    components.forEach(comp => {
        if (!groupedComponents[comp.type]) {
            groupedComponents[comp.type] = [];
        }
        
        // For folder-based metadata, add folder paths
        if (['Dashboard', 'Document', 'EmailTemplate'].includes(comp.type)) {
            // Extract folder path from the component's full path
            const fullPath = comp.apiName;
            const lastSlashIndex = fullPath.lastIndexOf('/');
            
            if (lastSlashIndex > -1) {
                const folderPath = fullPath.substring(0, lastSlashIndex);
                const folderParts = folderPath.split('/');
                let currentPath = '';
                
                // Add each folder level
                folderParts.forEach(part => {
                    currentPath = currentPath ? `${currentPath}/${part}` : part;
                    if (!groupedComponents[comp.type].includes(currentPath)) {
                        groupedComponents[comp.type].push(currentPath);
                    }
                });
            }
        }
        
        // Add the component itself
        groupedComponents[comp.type].push(comp.apiName);
    });

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';
    
    Object.keys(groupedComponents).forEach(type => {
        xml += `    <types>\n`;
        // Sort to ensure folders come before their contents
        groupedComponents[type].sort().forEach(member => {
            xml += `        <members>${member}</members>\n`;
        });
        xml += `        <name>${type}</name>\n    </types>\n`;
    });
    
    xml += `    <version>${apiVersion}</version>\n</Package>`;
    return xml;
}

async function getLatestApiVersion() {
    return new Promise((resolve) => {
        exec('sf org display --json', (error, stdout, stderr) => {
            if (error) {
                resolve('64.0');
                return;
            }
            
            try {
                const result = JSON.parse(stdout);
                const apiVersion = result.result?.apiVersion || '64.0';
                resolve(apiVersion);
            } catch (e) {
                resolve('64.0');
            }
        });
    });
}

async function getCurrentUserInfo() {
    return new Promise((resolve) => {
        exec('sf org display user --json', { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
            if (error) {
                console.log('Error querying current user:', error.message);
                resolve(null);
                return;
            }
            
            try {
                const result = JSON.parse(stdout);
                const userId = result.result?.id || null;
                resolve(userId);
            } catch (e) {
                console.log('Error parsing current user query result:', e.message);
                resolve(null);
            }
        });
    });
}

async function getComponentsFromSalesforce(metadataType) {
    // Handle folder-based metadata types with SOQL
    if (['Dashboard', 'Document', 'EmailTemplate'].includes(metadataType)) {
        return await getFolderBasedComponents(metadataType);
    }
    
    // Standard metadata API approach for other types
    const apiVersion = await getLatestApiVersion();
    return new Promise((resolve, reject) => {
        exec(`sf org list metadata --metadata-type ${metadataType} --api-version ${apiVersion} --json`, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
            if (error) {
                resolve([]);
                return;
            }
            
            try {
                const result = JSON.parse(stdout);
                const components = result.result.map(item => ({
                    name: item.fullName,
                    apiName: item.fullName
                })).sort((a, b) => a.name.localeCompare(b.name));
                resolve(components);
            } catch (e) {
                resolve([]);
            }
        });
    });
}

async function getFolderBasedComponents(metadataType) {
    return new Promise((resolve) => {
        // Query the main object with all available fields for debugging
        const soql = `SELECT Id, FolderId, DeveloperName, Name, Folder.DeveloperName, Folder.Name FROM ${metadataType}`;
        console.log('Querying:', soql);
        
        exec(`sf data query --query "${soql}" --json`, { maxBuffer: 1024 * 1024 * 50 }, async (error, stdout, stderr) => {
            if (error) {
                console.log('Error querying main object:', error.message);
                resolve([]);
                return;
            }
            
            try {
                const result = JSON.parse(stdout);
                let records = result.result.records || [];
                console.log('Found records:', records.length);
                console.log('Sample record:', records[0]);
                
                if (records.length === 0) {
                    resolve([]);
                    return;
                }
                
                // Get current user ID to filter records
                const currentUserId = await getCurrentUserInfo();
                console.log('Current user ID:', currentUserId);
                
                // Filter out records where FolderId is a user ID that is not the current user
                records = records.filter(record => {
                    // If FolderId is not a user ID (doesn't start with '005'), keep the record
                    if (!record.FolderId || !record.FolderId.startsWith('005')) {
                        return true;
                    }
                    
                    // If FolderId is a user ID, check if it's the current user
                    return record.FolderId === currentUserId;
                });
                
                console.log('Records after filtering:', records.length);
                
                // Collect folder IDs and separate org IDs from actual folder IDs
                const allFolderIds = [...new Set(records.map(r => r.FolderId).filter(id => id))];
                const orgIds = allFolderIds.filter(id => id.startsWith('00D'));
                const actualFolderIds = allFolderIds.filter(id => !id.startsWith('00D'));
                console.log('All Folder IDs:', allFolderIds);
                console.log('Org IDs:', orgIds);
                console.log('Actual Folder IDs:', actualFolderIds);
                
                // Create folder map with org IDs as unfiled$public
                const folderMap = {};
                orgIds.forEach(orgId => {
                    folderMap[orgId] = 'unfiled$public';
                });
                
                if (actualFolderIds.length === 0) {
                    console.log('No actual folder IDs found, using org mapping only');
                    // Create components with org folder mapping
                    const components = records.map(record => {
                        const folderPath = folderMap[record.FolderId] || '';
                        const fullPath = folderPath ? `${folderPath}/${record.DeveloperName}` : record.DeveloperName;
                        console.log(`Component: ${record.DeveloperName}, FolderId: ${record.FolderId}, FolderPath: ${folderPath}, FullPath: ${fullPath}`);
                        
                        return {
                            name: fullPath,
                            apiName: fullPath,
                            folderId: record.FolderId,
                            folderPath: folderPath
                        };
                    }).sort((a, b) => a.name.localeCompare(b.name));
                    
                    resolve(components);
                    return;
                }
                
                // Query actual folders
                const folderSoql = `SELECT DeveloperName, Id, ParentId FROM Folder WHERE Id IN ('${actualFolderIds.join("','")}')`;
                console.log('Querying folders:', folderSoql);
                
                exec(`sf data query --query "${folderSoql}" --json`, { maxBuffer: 1024 * 1024 * 50 }, (folderError, folderStdout, folderStderr) => {
                    if (folderError) {
                        console.log('Error querying folders:', folderError.message);
                        resolve([]);
                        return;
                    }
                    
                    try {
                        const folderResult = JSON.parse(folderStdout);
                        const folders = folderResult.result.records || [];
                        console.log('Found folders:', folders.length);
                        console.log('Sample folder:', folders[0]);
                        
                        // Build folder hierarchy map for actual folders
                        const actualFolderMap = buildFolderHierarchy(folders);
                        
                        // Merge with org folder map
                        Object.assign(folderMap, actualFolderMap);
                        console.log('Combined folder map:', folderMap);
                        
                        // Create components with folder paths
                        const components = records.map(record => {
                            const folderPath = folderMap[record.FolderId] || '';
                            const fullPath = folderPath ? `${folderPath}/${record.DeveloperName}` : record.DeveloperName;
                            console.log(`Component: ${record.DeveloperName}, FolderId: ${record.FolderId}, FolderPath: ${folderPath}, FullPath: ${fullPath}`);
                            
                            return {
                                name: fullPath,
                                apiName: fullPath,
                                folderId: record.FolderId,
                                folderPath: folderPath
                            };
                        }).sort((a, b) => a.name.localeCompare(b.name));
                        
                        resolve(components);
                    } catch (e) {
                        console.log('Error parsing folder result:', e.message);
                        resolve([]);
                    }
                });
            } catch (e) {
                console.log('Error parsing main result:', e.message);
                resolve([]);
            }
        });
    });
}

function buildFolderHierarchy(folders) {
    const folderMap = {};
    const folderById = {};
    
    // Create lookup map
    folders.forEach(folder => {
        folderById[folder.Id] = folder;
    });
    
    // Build hierarchy paths
    function getPath(folderId, visited = new Set()) {
        if (!folderId || visited.has(folderId)) return '';
        
        const folder = folderById[folderId];
        if (!folder) return '';
        
        visited.add(folderId);
        
        if (!folder.ParentId) {
            return folder.DeveloperName;
        }
        
        const parentPath = getPath(folder.ParentId, visited);
        return parentPath ? `${parentPath}/${folder.DeveloperName}` : folder.DeveloperName;
    }
    
    folders.forEach(folder => {
        folderMap[folder.Id] = getPath(folder.Id);
    });
    
    return folderMap;
}

async function getMetadataTypesFromSalesforce() {
    const apiVersion = await getLatestApiVersion();
    return new Promise((resolve, reject) => {
        exec(`sf org list metadata-types --api-version ${apiVersion} --json`, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
            if (error) {
                reject(`ERROR: ${error.message}`);
                return;
            }
            
            try {
                const result = JSON.parse(stdout);
                
                if (result.status === 1) {
                    reject(`ERROR: ${result.message || 'Command failed'}`);
                    return;
                }
                
                const metadataTypes = [];
                
                const convertPascalToLabel = (pascalStr) => {
                    return pascalStr.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').trim();
                };
                
                if (result.result && Array.isArray(result.result.metadataObjects)) {
                    result.result.metadataObjects.forEach(obj => {
                        metadataTypes.push({
                            name: obj.xmlName,
                            label: convertPascalToLabel(obj.xmlName)
                        });
                        
                        if (obj.childXmlNames && Array.isArray(obj.childXmlNames)) {
                            obj.childXmlNames.forEach(childName => {
                                metadataTypes.push({
                                    name: childName,
                                    label: convertPascalToLabel(childName)
                                });
                            });
                        }
                    });
                }
                
                const uniqueTypes = metadataTypes.filter((type, index, self) => 
                    index === self.findIndex(t => t.name === type.name)
                ).sort((a, b) => a.label.localeCompare(b.label));
                
                resolve(uniqueTypes);
            } catch (e) {
                reject(`ERROR: ${e.message}`);
            }
        });
    });
}

function getWebviewContent() {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Salesforce Metadata Manager</title>
        <style>
            body { font-family: 'Salesforce Sans', Arial, sans-serif; font-size: 14px; line-height: 1.5; padding: 24px; background: #f3f3f3; color: #181818; }
            h1 { font-size: 25px; font-weight: 300; color: #003876; margin-bottom: 24px; font-family: 'Aptos', Arial, sans-serif; }
            .form-group { margin-bottom: 16px; }
            label { display: block; margin-bottom: 8px; font-weight: 300; font-size: 20px; color: #444444; font-family: 'Aptos', Arial, sans-serif; }
            select, input { width: 100%; padding: 12px 16px; border: 1px solid #d8dde6; border-radius: 4px; background: white; color: #181818; font-size: 14px; font-family: 'Salesforce Sans', Arial, sans-serif; }
            input[readonly] { width: calc(100% - 32px); }
            select:focus, input:focus { outline: none; border-color: #1589ee; box-shadow: 0 0 0 2px rgba(21, 137, 238, 0.1); }
            select:disabled { background: #f3f3f3; color: #706e6b; }
            button:disabled { background: #dddbda !important; color: #706e6b; cursor: not-allowed; }
            button:enabled { background: #1589ee !important; }
            table { width: 100%; border-collapse: collapse; margin-top: 0px; background: white; border-radius: 4px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            th, td { padding: 0px 8px; text-align: left; border-bottom: 1px solid #e5e5e5; height: 32px; vertical-align: middle; line-height: 32px; }
            th { background: #e8e8e8; color: #444444; font-weight: 600; font-size: 15px; font-family: 'Aptos', Arial, sans-serif; }
            td { font-size: 14px; color: #181818; }
            th:last-child, td:last-child { text-align: center; vertical-align: middle; }
            .remove-btn { background: #d73a49; color: white; border: none; cursor: pointer; font-size: 10px; height: 20px; width: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }
            .remove-btn:hover { background: #cb2431; }
            #selectedComponentTable { border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            /* Combobox styles */
            .combobox-container { position: relative; width: 100%; }
            .combobox-input { width: 100%; padding: 12px 16px; border: 1px solid #d8dde6; border-radius: 4px; background: white; font-size: 14px; font-family: 'Salesforce Sans', Arial, sans-serif; font-style: normal; }
            .combobox-input.error { color: #dc3545; font-weight: bold; font-style: italic; }
            .combobox-input.error::placeholder { color: #dc3545; font-weight: bold; font-style: italic; }
            .combobox-input:focus { outline: none; border-color: #1589ee; box-shadow: 0 0 0 2px rgba(21, 137, 238, 0.1); }
            .dropdown-list { position: absolute; top: 100%; left: 0; right: 0; background: white; border: 1px solid #d8dde6; border-top: none; border-radius: 0 0 4px 4px; max-height: 200px; overflow-y: auto; z-index: 1000; display: none; }
            .dropdown-item { padding: 8px 16px; cursor: pointer; }
            .dropdown-item:hover { background-color: #f3f3f3; }
            .dropdown-item.selected { background-color: #eef4ff; }
            .dropdown-item.highlighted { background-color: #eef4ff; }
            .spinner {
                border: 2px solid #f3f3f3;
                border-top: 2px solid #0070d2;
                border-radius: 50%;
                width: 16px;
                height: 16px;
                animation: spin 1s linear infinite;
                display: none;
                margin-left: 10px;
                vertical-align: middle;
            }
            /* Tooltip styles */
            .tooltip {
                position: relative;
                display: inline-block;
            }
            
            .tooltip .tooltiptext {
                visibility: hidden;
                width: 400px;
                background-color: black;
                color: #dc3545;
                text-align: left;
                border-radius: 4px;
                padding: 8px 12px;
                position: absolute;
                z-index: 1;
                bottom: 125%;
                left: 50%;
                margin-left: -200px;
                opacity: 0;
                transition: opacity 0.3s;
                font-style: italic;
                font-size: 12px;
                border: 1px solid #dc3545;
                box-sizing: border-box;
                max-width: 90vw;
                word-wrap: break-word;
                line-height: 1.4;
            }
            
            .tooltip:hover .tooltiptext {
                visibility: visible;
                opacity: 1;
            }
            
            .tooltip .tooltiptext::after {
                content: "";
                position: absolute;
                top: 100%;
                left: 50%;
                margin-left: -5px;
                border-width: 5px;
                border-style: solid;
                border-color: #dc3545 transparent transparent transparent;
            }
            
            /* Ensure tooltip stays within screen bounds */
            @media screen and (max-width: 500px) {
                .tooltip .tooltiptext {
                    width: 90vw;
                    margin-left: -45vw;
                    left: 50%;
                }
            }
        </style>
    </head>
    <body>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
            <h1 style="margin: 0;">Salesforce Metadata Manager</h1>
            <div style="display: flex; flex-direction: column; align-items: center;">
                <button id="retrieveBtn" disabled style="padding: 12px 24px; background: #1589ee; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; font-family: 'Salesforce Sans', Arial, sans-serif; display: flex; align-items: center;">
                    <span>Retrieve Components</span>
                    <div id="retrieveSpinner" class="spinner" style="margin-left: 10px;"></div>
                </button>
            </div>
        </div>
        
        <div class="form-group">
            <div>
                <label>Metadata Type</label>
            </div>
            <div class="combobox-container">
                <input id="metadataTypeInput" class="combobox-input" type="text" placeholder="Select metadata type" style="width: calc(100% - 32px); padding: 12px 16px; border: 1px solid #d8dde6; border-radius: 4px; background: white; color: #181818; font-size: 14px; font-family: 'Salesforce Sans', Arial, sans-serif; font-style: italic;">
                <div id="metadataTypeSpinner" class="spinner" style="position: absolute; right: 16px; top: 35%; transform: translateY(-50%);"></div>
                <div id="metadataTypeDropdown" class="dropdown-list"></div>
            </div>
        </div>

        <div class="form-group">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <label>Available Components</label>
                <button id="addComponentBtn" style="padding: 6px 12px; background: #1589ee; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; font-family: 'Salesforce Sans', Arial, sans-serif; display: none;">Add</button>
            </div>
            <div id="componentDiv" style="border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); background: white; min-height: 100px;">
                <div id="noComponentsMessage" style="padding: 20px; text-align: center; color: #706e6b; font-style: italic; display: flex; align-items: center; justify-content: center; height: 100px;">No components available</div>
                <div id="loadingComponentsMessage" style="padding: 20px; text-align: center; color: #706e6b; font-style: italic; display: none; flex-direction: column; align-items: center; justify-content: center; height: 100px;">
                    <span id="loadingComponentsText"></span>
                    <div class="spinner" style="margin-top: 10px; display: inline-block;"></div>
                </div>
            </div>
            <div id="searchComponentContainer" style="display: none; padding: 0; margin-bottom: 1px;">
                <input type="text" id="searchComponentInput" placeholder="Search components..." style="width: calc(100% - 32px); padding: 12px 16px; border: 1px solid #d8dde6; border-radius: 4px; background: white; color: #181818; font-size: 14px; font-family: 'Salesforce Sans', Arial, sans-serif; font-style: italic;">
            </div>
            <div id="componentTableContainer" style="display: none; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); background: white; max-height: 192px; overflow-y: auto;">
                <table id="availableComponentTable" style="width: 100%; border-collapse: collapse; margin-top: 0px; background: white; border-radius: 4px;">
                    <tbody id="componentTableBody">
                    </tbody>
                </table>
            </div>
        </div>
        
        <div class="form-group" style="margin-bottom: 5px;">
            <label>Selected Components</label>
        </div>
        <div id="selectedComponentTable">
            <div style="padding: 20px; text-align: center; color: #706e6b; font-style: italic;">No selected components</div>
        </div>


        <div id="resultSection" style="display: none; margin-top: 20px;">
            <div class="form-group">
                <label>Error Information</label>
                <div id="errorMessage" style="color: #dc3545; background: #f3f3f3; border: 1px solid #d8dde6; border-radius: 4px; padding: 12px 16px; width: calc(100% - 32px); min-height: 20px; line-height: 1.4;"></div>
            </div>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            let metadataTypes = [];
            let selectedComponents = [];
            

            function removeComponent(index) {
                const removedComponent = selectedComponents.splice(index, 1)[0];
                document.getElementById('resultSection').style.display = 'none';
                updateTable();
                
                // Check if the metadata type of the removed component matches the currently selected metadata type
                const metadataTypeInput = document.getElementById('metadataTypeInput');
                const currentMetadataType = metadataTypeInput.dataset.selectedType || '';
                
                if (removedComponent && removedComponent.type === currentMetadataType) {
                    // Add the removed component back to allComponents and sort
                    // Create a component object with the same structure as the ones from Salesforce
                    const componentToAdd = {
                        name: removedComponent.name || removedComponent.apiName,
                        apiName: removedComponent.apiName
                    };
                    
                    // Add to allComponents if it's not already there
                    if (!allComponents.some(comp => comp.apiName === componentToAdd.apiName)) {
                        allComponents.push(componentToAdd);
                        // Sort allComponents by name
                        allComponents.sort((a, b) => a.name.localeCompare(b.name));
                    }
                    
                    // Update the component table if it's visible
                    if (document.getElementById('componentTableContainer').style.display === 'block') {
                        // Repopulate component table
                        const componentTableBody = document.getElementById('componentTableBody');
                        componentTableBody.innerHTML = '';
                        
                        // Sort components by name
                        const sortedComponents = [...allComponents].sort((a, b) => a.name.localeCompare(b.name));
                        
                        sortedComponents.forEach(comp => {
                            const row = componentTableBody.insertRow();
                            row.innerHTML = \`
                                <td style="padding: 0px 8px; text-align: left; border-bottom: 1px solid #e5e5e5; height: 32px; vertical-align: middle; line-height: 32px; width: 2%;">
                                    <input type="checkbox" data-api-name="\${comp.apiName}" style="margin: 0; vertical-align: middle;">
                                </td>
                                <td style="padding: 0px 8px; text-align: left; border-bottom: 1px solid #e5e5e5; height: 32px; vertical-align: middle; line-height: 32px; font-size: 14px; color: #181818; width: 98%;">\${comp.name}</td>
                            \`;
                        });
                        
                        // Add event listeners to checkboxes
                        const checkboxes = componentTableBody.querySelectorAll('input[type="checkbox"]');
                        checkboxes.forEach(checkbox => {
                            checkbox.addEventListener('change', function() {
                                const apiName = this.dataset.apiName;
                                if (this.checked) {
                                    selectedAvailableComponents.add(apiName);
                                } else {
                                    selectedAvailableComponents.delete(apiName);
                                }
                                
                                // Show/hide add button based on selection
                                const addComponentBtn = document.getElementById('addComponentBtn');
                                if (selectedAvailableComponents.size > 0) {
                                    addComponentBtn.style.display = 'block';
                                } else {
                                    addComponentBtn.style.display = 'none';
                                }
                            });
                        });
                        
                        // Hide add button initially
                        document.getElementById('addComponentBtn').style.display = 'none';
                        
                        // Apply any existing search filter
                        const searchComponentInput = document.getElementById('searchComponentInput');
                        if (searchComponentInput && searchComponentInput.value) {
                            filterComponentsBySearch(searchComponentInput.value);
                        }
                    } else if (allComponents.length > 0) {
                        // Show component table with components
                        document.getElementById('componentDiv').style.display = 'none';
                        document.getElementById('searchComponentContainer').style.display = 'block';
                        document.getElementById('componentTableContainer').style.display = 'block';
                        
                        // Populate the component table
                        const componentTableBody = document.getElementById('componentTableBody');
                        componentTableBody.innerHTML = '';
                        
                        // Sort components by name
                        const sortedComponents = [...allComponents].sort((a, b) => a.name.localeCompare(b.name));
                        
                        sortedComponents.forEach(comp => {
                            const row = componentTableBody.insertRow();
                            row.innerHTML = \`
                                <td style="padding: 0px 8px; text-align: left; border-bottom: 1px solid #e5e5e5; height: 32px; vertical-align: middle; line-height: 32px; width: 2%;">
                                    <input type="checkbox" data-api-name="\${comp.apiName}" style="margin: 0; vertical-align: middle;">
                                </td>
                                <td style="padding: 0px 8px; text-align: left; border-bottom: 1px solid #e5e5e5; height: 32px; vertical-align: middle; line-height: 32px; font-size: 14px; color: #181818; width: 98%;">\${comp.name}</td>
                            \`;
                        });
                        
                        // Add event listeners to checkboxes
                        const checkboxes = componentTableBody.querySelectorAll('input[type="checkbox"]');
                        checkboxes.forEach(checkbox => {
                            checkbox.addEventListener('change', function() {
                                const apiName = this.dataset.apiName;
                                if (this.checked) {
                                    selectedAvailableComponents.add(apiName);
                                } else {
                                    selectedAvailableComponents.delete(apiName);
                                }
                                
                                // Show/hide add button based on selection
                                const addComponentBtn = document.getElementById('addComponentBtn');
                                if (selectedAvailableComponents.size > 0) {
                                    addComponentBtn.style.display = 'block';
                                } else {
                                    addComponentBtn.style.display = 'none';
                                }
                            });
                        });
                        
                        // Hide add button initially
                        document.getElementById('addComponentBtn').style.display = 'none';
                        
                        // Apply any existing search filter
                        const searchComponentInput = document.getElementById('searchComponentInput');
                        if (searchComponentInput && searchComponentInput.value) {
                            filterComponentsBySearch(searchComponentInput.value);
                        }
                    }
                }
            }

            function updateTable() {
                const tableContainer = document.getElementById('selectedComponentTable');
                const retrieveBtn = document.getElementById('retrieveBtn');
                
                retrieveBtn.disabled = selectedComponents.length === 0;
                
                if (selectedComponents.length === 0) {
                    retrieveBtn.style.background = '#dddbda';
                } else {
                    retrieveBtn.style.background = '#1589ee';
                }
                
                if (selectedComponents.length === 0) {
                    tableContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #706e6b; font-style: italic;">No selected components</div>';
                    document.getElementById('resultSection').style.display = 'none';
                    return;
                }
                
                if (!tableContainer.querySelector('table')) {
                    tableContainer.innerHTML = \`
                        <table>
                            <thead>
                                <tr>
                                    <th>Component API Name</th>
                                    <th>Metadata Type</th>
                                    <th>Retrieval Status</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody id="selectedComponents">
                            </tbody>
                        </table>
                    \`;
                }
                
                const tbody = document.getElementById('selectedComponents');
                tbody.innerHTML = '';
                
                selectedComponents.forEach((comp, index) => {
                    const convertPascalToLabel = (pascalStr) => {
                        return pascalStr.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').trim();
                    };
                    const typeLabel = metadataTypes.find(t => t.name === comp.type)?.label || convertPascalToLabel(comp.type);
                    const row = tbody.insertRow();
                    row.innerHTML = \`
                        <td>\${comp.apiName}</td>
                        <td>\${typeLabel}</td>
                        <td id="status-\${index}" style="text-align: left; font-weight: bold;">-</td>
                        <td><span class="remove-btn" onclick="removeComponent(\${index})">🗑️</span></td>
                    \`;
                });
            }

            // Variables for combobox functionality
            let allMetadataTypes = [];
            let filteredMetadataTypes = [];
            let allComponents = [];
            let selectedAvailableComponents = new Set();
            
            // Function to handle metadata type selection from combobox
            function onMetadataTypeSelect(metadataType) {
                const metadataTypeInput = document.getElementById('metadataTypeInput');
                
                // Store the selected metadata type
                metadataTypeInput.dataset.selectedType = metadataType;
                
                document.getElementById('resultSection').style.display = 'none';
                
                // Update retrieval status of selected components to '-'
                selectedComponents.forEach((comp, index) => {
                    const statusCell = document.getElementById('status-' + index);
                    if (statusCell) {
                        statusCell.textContent = '-';
                        statusCell.style.color = '#181818'; // Reset color to default
                        statusCell.style.fontWeight = 'bold';
                        statusCell.style.textAlign = 'left';
                    }
                });
                
                if (metadataType) {
                    const selectedType = allMetadataTypes.find(t => t.name === metadataType);
                    const typeName = selectedType ? selectedType.label : metadataType;
                    
                    // Show loading message in component div
                    document.getElementById('noComponentsMessage').style.display = 'none';
                    document.getElementById('loadingComponentsMessage').style.display = 'flex';
                    document.getElementById('loadingComponentsText').textContent = 'Loading components for metadata type ' + typeName + '...';
                    document.getElementById('componentDiv').style.display = 'block';
                    document.getElementById('searchComponentContainer').style.display = 'none';
                    document.getElementById('componentTableContainer').style.display = 'none';
                    document.getElementById('addComponentBtn').style.display = 'none';
                    
                    // Show spinner
                    const spinner = document.querySelector('#loadingComponentsMessage .spinner');
                    if (spinner) {
                        spinner.style.display = 'inline-block';
                    }
                    
                    vscode.postMessage({
                        command: 'getComponents',
                        metadataType: metadataType
                    });
                } else {
                    // Show no components message
                    // Hide spinner
                    const spinner = document.querySelector('#loadingComponentsMessage .spinner');
                    if (spinner) {
                        spinner.style.display = 'none';
                    }
                    document.getElementById('noComponentsMessage').style.display = 'flex';
                    document.getElementById('noComponentsMessage').innerHTML = 'No components available';
                    document.getElementById('loadingComponentsMessage').style.display = 'none';
                    document.getElementById('componentDiv').style.display = 'block';
                    document.getElementById('searchComponentContainer').style.display = 'none';
                    document.getElementById('componentTableContainer').style.display = 'none';
                    document.getElementById('addComponentBtn').style.display = 'none';
                    
                    // Clear component table
                    const componentTableBody = document.getElementById('componentTableBody');
                    if (componentTableBody) {
                        componentTableBody.innerHTML = '';
                    }
                    // Clear allComponents array
                    allComponents = [];
                    // Clear selectedAvailableComponents set
                    selectedAvailableComponents.clear();
                }
                
                // Don't reset the metadata type input to keep the selection visible
            }
            
            // Function to handle component selection from combobox
            // This function is no longer needed as we're using a table instead of a combobox
            
            // Function to populate metadata type combobox
            function populateMetadataTypeCombobox(metadataTypes) {
                const metadataTypeDropdown = document.getElementById('metadataTypeDropdown');
                
                // Clear dropdown
                metadataTypeDropdown.innerHTML = '';
                
                // Add options to dropdown
                metadataTypes.forEach(type => {
                    const item = document.createElement('div');
                    item.className = 'dropdown-item';
                    item.textContent = type.label;
                    item.dataset.value = type.name;
                    item.addEventListener('click', function() {
                        const metadataTypeInput = document.getElementById('metadataTypeInput');
                        metadataTypeInput.value = type.label;
                        metadataTypeInput.style.fontStyle = 'italic';
                        metadataTypeInput.style.color = '#181818';
                        document.getElementById('metadataTypeDropdown').style.display = 'none';
                        onMetadataTypeSelect(type.name);
                    });
                    metadataTypeDropdown.appendChild(item);
                });
            }
            
            // Function to populate component combobox
            function populateComponentCombobox(components) {
                // This function is no longer needed as we're using a table instead of a combobox
            }
            
            // Function to filter metadata types for combobox
            function filterMetadataTypes(searchText) {
                const metadataTypeInput = document.getElementById('metadataTypeInput');
                const metadataTypeDropdown = document.getElementById('metadataTypeDropdown');
                
                if (!searchText) {
                    filteredMetadataTypes = [...allMetadataTypes];
                } else {
                    filteredMetadataTypes = allMetadataTypes.filter(type =>
                        type.name.toLowerCase().includes(searchText.toLowerCase()) ||
                        type.label.toLowerCase().includes(searchText.toLowerCase())
                    );
                }
                
                // Update dropdown with filtered options
                populateMetadataTypeCombobox(filteredMetadataTypes);
                
                // Show dropdown if there are filtered results
                if (filteredMetadataTypes.length > 0) {
                    metadataTypeDropdown.style.display = 'block';
                } else {
                    metadataTypeDropdown.style.display = 'none';
                }
            }
            
            // Function to filter components for combobox
            function filterComponents(searchText) {
                // This function is no longer needed as we're using a table instead of a combobox
            }
            
            // Function to filter components by search text
            function filterComponentsBySearch(searchText) {
                const componentTableBody = document.getElementById('componentTableBody');
                const rows = componentTableBody.querySelectorAll('tr');
                
                // Split the search text by comma and trim each part
                const searchTerms = searchText.split(',').map(term => term.trim().toLowerCase()).filter(term => term.length > 0);
                
                // If no search terms, show all rows
                if (searchTerms.length === 0) {
                    rows.forEach(row => {
                        row.style.display = '';
                    });
                    return;
                }
                
                rows.forEach(row => {
                    const componentName = row.cells[1].textContent.toLowerCase();
                    
                    // Check if any of the search terms match the component name
                    const matchesComponent = searchTerms.some(term => componentName.includes(term));
                    
                    // Check if any of the search terms match the metadata type
                    const metadataType = document.getElementById('metadataTypeInput').dataset.selectedType || '';
                    const selectedType = allMetadataTypes.find(t => t.name === metadataType);
                    const typeLabel = selectedType ? selectedType.label.toLowerCase() : metadataType.toLowerCase();
                    const matchesType = searchTerms.some(term =>
                        metadataType.toLowerCase().includes(term) ||
                        typeLabel.includes(term)
                    );
                    
                    if (matchesComponent || matchesType) {
                        row.style.display = '';
                    } else {
                        row.style.display = 'none';
                    }
                });
            }
            
            // Add event listeners for comboboxes
            document.addEventListener('DOMContentLoaded', function() {
                const metadataTypeInput = document.getElementById('metadataTypeInput');
                const metadataTypeDropdown = document.getElementById('metadataTypeDropdown');
                const searchComponentInput = document.getElementById('searchComponentInput');
                
                // Handle input in the metadata type combobox
                metadataTypeInput.addEventListener('input', function() {
                    filterMetadataTypes(this.value);
                    highlightedMetadataIndex = -1;
                    
                    // Handle case when metadata type input is completely cleared
                    if (!this.value) {
                        // Clear any error messages
                        document.getElementById('resultSection').style.display = 'none';
                        
                        // Clear the stored selected metadata type
                        metadataTypeInput.dataset.selectedType = '';
                        
                        // Call onMetadataTypeSelect with empty string to reset component table
                        onMetadataTypeSelect('');
                    }
                });
                
                // Handle focus on the metadata type input
                metadataTypeInput.addEventListener('focus', function() {
                    if (allMetadataTypes.length > 0) {
                        filterMetadataTypes(this.value);
                    }
                });
                
                // Handle blur (click outside) on the metadata type input
                metadataTypeInput.addEventListener('blur', function() {
                    // Delay hiding the dropdown to allow for item selection
                    setTimeout(() => {
                        metadataTypeDropdown.style.display = 'none';
                    }, 150);
                });
                
                // Handle keyboard navigation for metadata type
                metadataTypeInput.addEventListener('keydown', function(e) {
                    const items = metadataTypeDropdown.querySelectorAll('.dropdown-item');
                    
                    switch (e.key) {
                        case 'ArrowDown':
                            e.preventDefault();
                            highlightedMetadataIndex = Math.min(highlightedMetadataIndex + 1, items.length - 1);
                            updateHighlightedMetadataItem(items);
                            break;
                        case 'ArrowUp':
                            e.preventDefault();
                            highlightedMetadataIndex = Math.max(highlightedMetadataIndex - 1, 0);
                            updateHighlightedMetadataItem(items);
                            break;
                        case 'Enter':
                            e.preventDefault();
                            if (highlightedMetadataIndex >= 0 && highlightedMetadataIndex < items.length) {
                                items[highlightedMetadataIndex].click();
                            }
                            break;
                        case 'Escape':
                            metadataTypeDropdown.style.display = 'none';
                            break;
                    }
                });
                
                // Handle input in the search component textbox
                searchComponentInput.addEventListener('input', function() {
                    filterComponentsBySearch(this.value);
                });
                
                // Function to update the highlighted metadata item in the dropdown
                function updateHighlightedMetadataItem(items) {
                    items.forEach((item, index) => {
                        if (index === highlightedMetadataIndex) {
                            item.classList.add('highlighted');
                        } else {
                            item.classList.remove('highlighted');
                        }
                    });
                    
                    // Scroll to the highlighted item if needed
                    if (highlightedMetadataIndex >= 0 && highlightedMetadataIndex < items.length) {
                        items[highlightedMetadataIndex].scrollIntoView({block: 'nearest'});
                    }
                }
            });
            
            function addComponents() {
                if (selectedAvailableComponents.size === 0) {
                    return;
                }
                
                const metadataTypeInput = document.getElementById('metadataTypeInput');
                const metadataType = metadataTypeInput.dataset.selectedType || '';
                const selectedType = metadataTypes.find(t => t.name === metadataType);
                const typeName = selectedType ? selectedType.label : metadataType;
                
                // Add selected components to the selected components table
                selectedAvailableComponents.forEach(apiName => {
                    const component = allComponents.find(c => c.apiName === apiName);
                    if (component) {
                        selectedComponents.push({
                            name: component.name,
                            apiName: component.apiName,
                            type: metadataType
                        });
                    }
                });
                
                updateTable();
                
                // Remove added components from allComponents
                allComponents = allComponents.filter(comp => !selectedAvailableComponents.has(comp.apiName));
                
                // Clear selected available components
                selectedAvailableComponents.clear();
                
                // Reset search input
                const searchComponentInput = document.getElementById('searchComponentInput');
                if (searchComponentInput) {
                    searchComponentInput.value = '';
                }
                
                // Update component table
                if (allComponents.length === 0) {
                    // Show no components message
                    document.getElementById('noComponentsMessage').style.display = 'flex';
                    const metadataType = document.getElementById('metadataTypeInput').dataset.selectedType || '';
                    const selectedType = metadataTypes.find(t => t.name === metadataType);
                    const typeName = selectedType ? selectedType.label : metadataType;
                    document.getElementById('noComponentsMessage').innerHTML = '<span style="color: #dc3545; font-style: italic; font-weight: bold;">No more components to select. All components of metadata type ' + typeName + ' are already selected.</span>';
                    document.getElementById('componentDiv').style.display = 'block';
                    document.getElementById('searchComponentContainer').style.display = 'none';
                    document.getElementById('componentTableContainer').style.display = 'none';
                    document.getElementById('addComponentBtn').style.display = 'none';
                } else {
                    // Repopulate component table
                    const componentTableBody = document.getElementById('componentTableBody');
                    componentTableBody.innerHTML = '';
                    
                    // Sort components by name
                    const sortedComponents = [...allComponents].sort((a, b) => a.name.localeCompare(b.name));
                    
                    sortedComponents.forEach(comp => {
                        const row = componentTableBody.insertRow();
                        row.innerHTML = \`
                            <td style="padding: 0px 8px; text-align: left; border-bottom: 1px solid #e5e5e5; height: 32px; vertical-align: middle; line-height: 32px; width: 2%;">
                                <input type="checkbox" data-api-name="\${comp.apiName}" style="margin: 0; vertical-align: middle;">
                            </td>
                            <td style="padding: 0px 8px; text-align: left; border-bottom: 1px solid #e5e5e5; height: 32px; vertical-align: middle; line-height: 32px; font-size: 14px; color: #181818; width: 98%;">\${comp.name}</td>
                        \`;
                    });
                    
                    // Add event listeners to checkboxes
                    const checkboxes = componentTableBody.querySelectorAll('input[type="checkbox"]');
                    checkboxes.forEach(checkbox => {
                        checkbox.addEventListener('change', function() {
                            const apiName = this.dataset.apiName;
                            if (this.checked) {
                                selectedAvailableComponents.add(apiName);
                            } else {
                                selectedAvailableComponents.delete(apiName);
                            }
                            
                            // Show/hide add button based on selection
                            const addComponentBtn = document.getElementById('addComponentBtn');
                            if (selectedAvailableComponents.size > 0) {
                                addComponentBtn.style.display = 'block';
                            } else {
                                addComponentBtn.style.display = 'none';
                            }
                        });
                    });
                    
                    // Hide add button
                    document.getElementById('addComponentBtn').style.display = 'none';
                }
            }
            
            function retrieveComponents() {
                if (selectedComponents.length === 0) {
                    return;
                }
                
                // Clear the metadata type input
                const metadataTypeInput = document.getElementById('metadataTypeInput');
                metadataTypeInput.value = '';
                metadataTypeInput.placeholder = 'Select or Search Metadata Type';
                metadataTypeInput.classList.remove('error');
                metadataTypeInput.style.color = '#181818';
                metadataTypeInput.style.fontWeight = 'normal';
                metadataTypeInput.style.fontStyle = 'italic';
                metadataTypeInput.dataset.selectedType = '';
                
                // Reset available components table
                onMetadataTypeSelect('');
                
                // Clear any error messages
                document.getElementById('resultSection').style.display = 'none';
                
                // Show spinner
                document.getElementById('retrieveSpinner').style.display = 'block';
                const retrieveBtn = document.getElementById('retrieveBtn');
                retrieveBtn.disabled = true;
                
                vscode.postMessage({
                    command: 'createPackage',
                    components: selectedComponents
                });
            }
            
            document.addEventListener('DOMContentLoaded', function() {
                document.getElementById('retrieveBtn').addEventListener('click', retrieveComponents);
                document.getElementById('addComponentBtn').addEventListener('click', addComponents);
                
                // Initialize comboboxes
                const metadataTypeInput = document.getElementById('metadataTypeInput');
                
                // Set initial placeholder text
                metadataTypeInput.placeholder = 'Loading all metadata types...';
                
                // Disable comboboxes while loading
                metadataTypeInput.disabled = true;
                
                // Show spinner for metadata types
                document.getElementById('metadataTypeSpinner').style.display = 'block';
                
                // Show no components message on page load
                document.getElementById('noComponentsMessage').style.display = 'flex';
                document.getElementById('noComponentsMessage').innerHTML = 'No components available';
                document.getElementById('componentDiv').style.display = 'block';
                document.getElementById('componentTableContainer').style.display = 'none';
                document.getElementById('addComponentBtn').style.display = 'none';
            });

            window.addEventListener('message', event => {
                const message = event.data;
                
                switch (message.command) {
                    case 'metadataTypesLoaded':
                        metadataTypes = message.metadataTypes;
                        allMetadataTypes = message.metadataTypes;
                        
                        // Hide spinner for metadata types
                        const metadataTypeSpinner = document.getElementById('metadataTypeSpinner');
                        if (metadataTypeSpinner) {
                            metadataTypeSpinner.style.display = 'none';
                        }
                        
                        // Enable the metadata type input
                        const metadataTypeInput = document.getElementById('metadataTypeInput');
                        if (metadataTypeInput) {
                            metadataTypeInput.disabled = false;
                            metadataTypeInput.placeholder = 'Select or Search Metadata Type';
                            metadataTypeInput.style.color = '#181818';
                            metadataTypeInput.style.fontStyle = 'italic';
                        }
                        
                        // Populate the metadata type combobox
                        populateMetadataTypeCombobox(message.metadataTypes);
                        break;
                        
                    case 'metadataTypesError':
                        // Hide spinner for metadata types
                        const metadataTypeErrorSpinner = document.getElementById('metadataTypeSpinner');
                        if (metadataTypeErrorSpinner) {
                            metadataTypeErrorSpinner.style.display = 'none';
                        }
                        
                        // Show error in the metadata type input
                        const metadataTypeInputError = document.getElementById('metadataTypeInput');
                        if (metadataTypeInputError) {
                            metadataTypeInputError.disabled = false;
                            metadataTypeInputError.placeholder = message.errorMessage;
                            metadataTypeInputError.style.color = '#dc3545';
                            metadataTypeInputError.style.fontWeight = 'bold';
                            metadataTypeInputError.style.fontStyle = 'italic';
                        }
                        
                        // Also hide component spinner if it was shown
                        const componentSpinner = document.getElementById('componentSpinner');
                        if (componentSpinner) {
                            componentSpinner.style.display = 'none';
                        }
                        break;
                        
                    case 'componentsLoaded':
                        // Filter out already selected components
                        const metadataType = document.getElementById('metadataTypeInput').dataset.selectedType || '';
                        const unselectedComponents = message.components.filter(comp =>
                            !selectedComponents.some(selected => selected.apiName === comp.apiName && selected.type === metadataType)
                        );
                        
                        allComponents = unselectedComponents;
                        
                        // Hide loading message and show component table
                        // Hide spinner
                        const spinner = document.querySelector('#loadingComponentsMessage .spinner');
                        if (spinner) {
                            spinner.style.display = 'none';
                        }
                        document.getElementById('loadingComponentsMessage').style.display = 'none';
                        
                        // Check if no components were retrieved
                        if (message.components.length === 0) {
                            // Hide spinner
                            const spinner = document.querySelector('#loadingComponentsMessage .spinner');
                            if (spinner) {
                                spinner.style.display = 'none';
                            }
                            document.getElementById('noComponentsMessage').style.display = 'flex';
                            const metadataType = document.getElementById('metadataTypeInput').dataset.selectedType || '';
                            const selectedType = metadataTypes.find(t => t.name === metadataType);
                            const typeName = selectedType ? selectedType.label : metadataType;
                            document.getElementById('noComponentsMessage').innerHTML = '<span style="color: #dc3545; font-style: italic; font-weight: bold;">No components retrieved for ' + typeName + '. There may be no components or you may miss enough permissions to retrieve them.</span>';
                            document.getElementById('componentDiv').style.display = 'block';
                            document.getElementById('componentTableContainer').style.display = 'none';
                            document.getElementById('addComponentBtn').style.display = 'none';
                        } else if (unselectedComponents.length === 0) {
                            // All components are already selected
                            // Hide spinner
                            const spinner = document.querySelector('#loadingComponentsMessage .spinner');
                            if (spinner) {
                                spinner.style.display = 'none';
                            }
                            document.getElementById('noComponentsMessage').style.display = 'flex';
                            const metadataType = document.getElementById('metadataTypeInput').dataset.selectedType || '';
                            const selectedType = metadataTypes.find(t => t.name === metadataType);
                            const typeName = selectedType ? selectedType.label : metadataType;
                            document.getElementById('noComponentsMessage').innerHTML = '<span style="color: #dc3545; font-style: italic; font-weight: bold;">No more components to select. All components of metadata type ' + typeName + ' are already selected.</span>';
                            document.getElementById('componentDiv').style.display = 'block';
                            document.getElementById('searchComponentContainer').style.display = 'none';
                            document.getElementById('componentTableContainer').style.display = 'none';
                            document.getElementById('addComponentBtn').style.display = 'none';
                        } else {
                            // Show component table with components
                            document.getElementById('componentDiv').style.display = 'none';
                            document.getElementById('searchComponentContainer').style.display = 'block';
                            document.getElementById('componentTableContainer').style.display = 'block';
                            
                            // Populate the component table
                            const componentTableBody = document.getElementById('componentTableBody');
                            componentTableBody.innerHTML = '';
                            
                            // Sort components by name
                            const sortedComponents = [...unselectedComponents].sort((a, b) => a.name.localeCompare(b.name));
                            
                            sortedComponents.forEach(comp => {
                                const row = componentTableBody.insertRow();
                                row.innerHTML = \`
                                    <td style="padding: 0px 8px; text-align: left; border-bottom: 1px solid #e5e5e5; height: 32px; vertical-align: middle; line-height: 32px; width: 2%;">
                                        <input type="checkbox" data-api-name="\${comp.apiName}" style="margin: 0; vertical-align: middle;">
                                    </td>
                                    <td style="padding: 0px 8px; text-align: left; border-bottom: 1px solid #e5e5e5; height: 32px; vertical-align: middle; line-height: 32px; font-size: 14px; color: #181818; width: 98%;">\${comp.name}</td>
                                \`;
                            });
                            
                            // Add event listeners to checkboxes
                            const checkboxes = componentTableBody.querySelectorAll('input[type="checkbox"]');
                            checkboxes.forEach(checkbox => {
                                checkbox.addEventListener('change', function() {
                                    const apiName = this.dataset.apiName;
                                    if (this.checked) {
                                        selectedAvailableComponents.add(apiName);
                                    } else {
                                        selectedAvailableComponents.delete(apiName);
                                    }
                                    
                                    // Show/hide add button based on selection
                                    const addComponentBtn = document.getElementById('addComponentBtn');
                                    if (selectedAvailableComponents.size > 0) {
                                        addComponentBtn.style.display = 'block';
                                    } else {
                                        addComponentBtn.style.display = 'none';
                                    }
                                });
                            });
                            
                            // Hide add button initially
                            document.getElementById('addComponentBtn').style.display = 'none';
                            
                            // Apply any existing search filter
                            const searchComponentInput = document.getElementById('searchComponentInput');
                            if (searchComponentInput && searchComponentInput.value) {
                                filterComponentsBySearch(searchComponentInput.value);
                            }
                        }
                        break;
                        
                    case 'loadExistingComponents':
                        selectedComponents = message.components;
                        updateTable();
                        break;
                        
                    case 'updateRetrievalStatus':
                        const failedComponents = [];
                        // Store error messages for each component
                        const componentErrorMessages = {};
                        message.results.forEach(result => {
                            const statusCell = document.getElementById(\`status-\${result.index}\`);
                            if (statusCell) {
                                statusCell.textContent = result.status;
                                statusCell.style.color = result.status === 'Success' ? '#28a745' : '#dc3545';
                                statusCell.style.fontWeight = 'bold';
                                statusCell.style.textAlign = 'left';
                                
                                if (result.status === 'Failed') {
                                    failedComponents.push(selectedComponents[result.index]);
                                    // Store error message for this component
                                    if (result.errorMessage) {
                                        componentErrorMessages[result.index] = result.errorMessage;
                                        // Add tooltip to the status cell
                                        statusCell.classList.add('tooltip');
                                        statusCell.innerHTML = \`\${result.status}<span class="tooltiptext">\${result.errorMessage}</span>\`;
                                    }
                                }
                            }
                        });
                        
                        // Show error section if there are errors and components exist
                        // Hide error section if error type is "command" or "component"
                        if (message.errorMessage && selectedComponents.length > 0 && message.errorType !== 'command' && message.errorType !== 'component') {
                            document.getElementById('resultSection').style.display = 'block';
                            document.getElementById('errorMessage').innerHTML = message.errorMessage;
                        } else {
                            document.getElementById('resultSection').style.display = 'none';
                        }
                        
                        // Hide spinner and re-enable button
                        document.getElementById('retrieveSpinner').style.display = 'none';
                        const retrieveBtn = document.getElementById('retrieveBtn');
                        retrieveBtn.disabled = selectedComponents.length === 0;
                        break;
                }
            });
            
            vscode.postMessage({ command: 'getMetadataTypes' });
            
            setTimeout(() => {
                vscode.postMessage({ command: 'loadExisting' });
            }, 1500);
        </script>
    </body>
    </html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
