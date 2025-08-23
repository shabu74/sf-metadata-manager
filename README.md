# Salesforce Metadata Manager

A Visual Studio Code extension that provides a user-friendly interface for managing and retrieving Salesforce metadata components. Create package.xml files and retrieve metadata with just a few clicks.

[![Salesforce Metadata Manager Interface](https://img.youtube.com/vi/ZOd2LqGjx8s/maxresdefault.jpg)](https://www.youtube.com/watch?v=ZOd2LqGjx8s)
*Short video of the Salesforce Metadata Manager*

## Features

### 1. Automatic Metadata Type Loading
All metadata types available in your connected org will be automatically loaded when the extension starts, providing a complete list of available metadata types.

![Automatic Metadata Type Loading](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/page-load-with-no-packagexml.png)
*Automatic metadata type loading*

### 2. Metadata Type Search and Selection
You can search for a particular metadata type with keyword filtering, making it easy to find the specific metadata type you need.

![Metadata Type Search Selection](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/metadata-type-search.png)
*Search and select metadata types using keyword filters*

### 3. Smart Component Loading
On selecting a metadata type, all components of that type will be automatically loaded in a table, except for currently selected components or those already in existing package.xml. This prevents duplicate selections and ensures efficient workflow.

![Smart Component Loading](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/retrieving-components.png)
*Smart component loading*

![Retrieved Components](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/retrieved-components.png)
*Retrieved components*

### 4. Component Search and Selection
You can search for a particular component with comma-separated keyword filtering, allowing you to quickly find specific components within a metadata type.

![Component Search and Selection](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/component-search.png)
*Search and select components using keyword filters*

### 5. Selected Components Management
On selecting a component, Add button will displayed.

![Add Button](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/add-button.png)
*Add button*

On cicking Add button, all selected components will be available in the selected components table for retrieval. The table provides a clear overview of all selected components with their metadata types.

![Selected Components](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/selected-components.png)
*Selected components table with metadata types*

### 6. Existing Package Support
Components available in existing package.xml are also loaded back to the selected components table, allowing you to continue working with your existing metadata selections.

![Existing PackagexmlComponents Loading](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/page-load-with-existing-packagexml.png)
*Existing package.xml Components Loading*

### 7. Smart Component Filtering
Selected components will not be available for future selection, preventing duplicates. If you remove a component from the selected components table, that component will be available back for future selection.

### 8. Component Availability Alerts
If selected metadata has no components, you will be alerted that there are no components.

![No Components Alert](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/no-components-error.png)
*Alert when no components are available for the selected metadata type*

If selected metadata has components and all components are already selected, you will be alerted that there are no more components to select.

![No More Components to Select Alert](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/no-components-to-select-error.png)
*Alert when all components are selected and no more components are available for selection*

### 9. Package.xml Generation and Retrieval
On clicking Retrieve Components, package.xml will be created in the manifest folder and selected components will be retrieved from your Salesforce org.

![Package.xml Creation](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/created-package-xml.png)
*Automatically generated package.xml with selected components*

![Successful Retrieval of Components](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/retrieval-success.png)
*Retrieved selected components successfully*

### 10. Retrieval Status Tracking
Real-time status updates are provided for each component during the retrieval process:
- `-` (default): Not yet retrieved
- ✅ **Success** (green): Component retrieved successfully
- ❌ **Failed** (red): Component retrieval failed

### 11. Error Handling and Reporting
The extension provides comprehensive error handling. If the retrieval of some components fails, retrieval status will be marked as Success for retrieved components and Failed for failed components. When you hover your mouse over the retrieval status 'Failed,' you will see error information as a tooltip.

![Retrieval Error](https://raw.githubusercontent.com/shabu74/sf-metadata-manager/main/screenshots/retrieval-with-error.png)
*Detailed error information for failed component retrievals as tooltip*

## Prerequisites

- Visual Studio Code
- Salesforce CLI (sf) installed and configured
- Authenticated Salesforce org connection

## Installation

1. Download the `.vsix` file
2. Open VS Code
3. Press `Ctrl+Shift+P` and type "Extensions: Install from VSIX"
4. Select the downloaded `.vsix` file
5. Restart VS Code

## Usage

### Opening the Extension

**Method 1: Command Palette**
1. Press `Ctrl+Shift+P`
2. Type "Salesforce: Open Metadata Manager"
3. Press Enter

**Method 2: Context Menu**
1. Right-click on any folder in the Explorer
2. Select "Open Metadata Manager"

### Selecting Components

1. **Search and Select Metadata Type**: Use the search box to find and select a metadata type (e.g., Apex Class, Custom Object)
2. **Search and Multi-select Components**: Use the component search text box to find and multi-select specific components from the table
3. **Review Selection**: View selected components in the table below with real-time status updates

### Loading Indicators

- **Progress Spinners**: Visual indicators show when metadata types and components are loading
- **No Components Message**: Clear notification when no components are found for a selected metadata type
- **Smart Component Filtering**: Selected components are automatically filtered out from future selections

### Retrieving Components

1. Click the **"Retrieve Components"** button (top-right)
2. Watch the progress indicator
3. Check the **Retrieval Status** column for results:
   - ✅ **Success** (green): Component retrieved successfully
   - ❌ **Failed** (red): Component retrieval failed
4. View error details in the **Error Details** section (if any failures occur)

### Managing Components

- **Remove Components**: Click the 🗑️ icon next to any component to deselect it and make it available for future selection
- **Load Existing**: Automatically loads components from existing `manifest/package.xml`
- **Package.xml Location**: Generated files are saved to `manifest/package.xml`
- **Smart Component Filtering**: Selected components are automatically filtered out from future selections, preventing duplicates

## Requirements

- **Salesforce CLI**: Must be installed and available in PATH
- **Authenticated Org**: Run `sf org login web` to authenticate
- **Salesforce Project**: Must be in a valid Salesforce DX project directory

## Version History

### 1.1.4
- Implemented multiselection of components for more efficient workflow
- Improved error handling with better error detection and reporting
- Enhanced user experience with error messages displayed as tooltips

### 1.1.3
- Implemented logic to treat "MetadataTransferError: Metadata API request failed: Could not find HEAD" errors as success. This error typically occurs in Salesforce Developer Sandboxes with source tracking enabled and despite the error message, the deployment or retrieval operation often completes successfully.

### 1.1.2
- Implemented search and select feature for both metadata type and component comboboxes
- Selected components will not be available for future selection
- If we deselect component, it will be available for future selection

### 1.1.1
- Added progress spinners for metadata type and component loading
- Improved error messaging for "no components retrieved" scenarios
- Enhanced user feedback during loading processes

### 1.1.0
- Email templates, documents, and dashboards in personal folders will not be displayed
- Enhanced filtering for folder-based metadata types

### 1.0.2
- Added visual interface for metadata management
- Implemented real-time retrieval status tracking
- Added error reporting and details
- Support for existing package.xml files

## License

MIT License - see LICENSE file for details

## Author

**Shabu Thomas**  
Email: ars.shabu@gmail.com

---

**Note**: This extension requires an active Salesforce CLI installation and authenticated org connection to function properly.