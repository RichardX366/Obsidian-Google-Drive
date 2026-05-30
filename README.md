# Google Drive Sync

This is an unofficial sync plugin for Obsidian, specifically for Google Drive.

## Disclaimer

-   This is **not** the [official sync service](https://obsidian.md/sync) provided by Obsidian
-   This plugin communicates with external servers, namely the Google Drive API and [https://ogd.richardxiong.com](https://ogd.richardxiong.com)
    -   The details of this communication are explained at the bottom of the notes section

## Caution

**ALWAYS backup your vault before using this plugin.**

## Features

-   Syncing both ways (from Obsidian to Google Drive and back)
-   Cross-device support
-   Obsidian iOS app support
-   Local file prioritization (automatically resolves conflicts)
-   Multiple vaults per Google account
-   Configuration syncing

## New Devices

-   If you've already been using this plugin and want to start using it on a new device, then follow these instructions:
    1. Open Google Drive and download the entire Obsidian folder to your new device
    2. Move the Obsidian folder to the location where you want your vault to be
    3. Open Obsidian and set the vault location to the folder you just moved
-   If you activate the plugin on a new device without downloading the Obsidian folder from Google Drive, the plugin will start downloading from Google Drive as per a typical sync, which could take an extremely long amount of time depending on the number of notes in Google Drive, but it would still work (we suggest the above method instead)

## Notes

-   Do **NOT** manually upload files into the generated Obsidian Google Drive folder or use some other method of Google Drive sync
    -   Our plugin cannot see these files, and it will likely break functionality, potentially causing data loss
    -   Instead, use this plugin on any device you wish to sync the vault between
-   Do **NOT** manually change files outside of the Obsidian app
    -   Our plugin tracks file changes through the Obsidian API, and if you change files outside of the app, the plugin will not be able to track these changes
-   If you ever encounter the following situation or vice versa, SYNC after you delete/rename it and before you rename/create the file/folder with the exact same path (this error arises from our plugin seeing a file convert into a folder or vice versa) (this doesn't apply for file to file or folder to folder):
    -   You have a file that has NO file extension already synced (most files have a file extension so you usually don't have to worry about this)
    -   You delete it/rename it
    -   You rename/create a folder with the exact same path
-   When activating this plugin on a new vault, make sure the vault is empty
    -   If you have files that you want to sync to Google Drive from before the plugin, move them to another vault, delete them from the current vault, activate the plugin, and copy them back in **THROUGH THE OBSIDIAN APP**
-   We suggest only editing Obsidian notes on one device at a time to avoid conflicts and syncing before editing on another device
    -   Our plugin does have code to handle conflicts, but it might not be perfect or as the user expects, so try to avoid them
-   Make sure to sync with an adequate internet connection
    -   Closing the app or losing connection while syncing could lead to data corruption
-   The plugin does NOT have manual conflict resolution
    -   If you encounter a conflict, the plugin will automatically resolve it with local file prioritization
-   Do **NOT** change the Obsidian configuration folder
    -   If you really want to, make a new vault, change the folder, enable the plugin, and copy your files over (you can move the contents of .obsidian to the new folder through file explorer)
-   This only accesses the Google Drive API to sync files and does not access or store any data outside of the user's device
-   This only accesses [https://ogd.richardxiong.com](https://ogd.richardxiong.com) to convert refresh tokens into access tokens (while hiding the client secret) and to check internet connectivity with a simple ping request

## Setup

Note: Instructions are also on this plugin's homepage with images at [https://ogd.richardxiong.com](https://ogd.richardxiong.com)

1. Visit this plugin's homepage at [https://ogd.richardxiong.com](https://ogd.richardxiong.com)
2. Click `Sign In` at the top right and log in with your Google account
3. Copy the refresh token that appears after logging in
4. Enable the Google Drive Sync plugin in Obsidian
5. Paste the refresh token into the plugin settings in Obsidian
6. Reload the Obsidian app

## Use

-   After setup, the plugin will automatically sync your vault with Google Drive whenever Obsidian is open
    -   This sync is from Google Drive TO Obsidian, not the other way around (pulling cloud files)
    -   The plugin prioritizes unsynced local changes except for local file deletions (cloud file creation/modification will overwrite local deletion)
    -   You can pull by running the `Pull from Google Drive` command
    -   Pulling new plugins/configurations may require a restart of Obsidian
-   To sync local changes to Google Drive, click the sync button on the ribbon or run the `Push to Google Drive` command from the command palette
    -   While you do not have to sync before you close Obsidian, we suggest doing so to ensure that Google Drive is up to date and no conflicts occur
    -   This will pull changes before pushing changes to Google Drive
    -   You can enable automatic pushes in the plugin settings. This is disabled by default. When enabled, the plugin waits 15 seconds after the most recent local change and also checks every 60 seconds for queued changes.
-   If you want to set your local vault state to the Google Drive state, run the `Set Local Vault to Google Drive` command
-   If you mess with the vault's files while Obsidian is closed, try to revert any of the changes you made

## Multiple Vaults

-   The Google Drive folder that gets created upon setup is the root folder for the vault and is tagged with the vault name
    -   It is named the same as your vault name, has a matching description, and stores the vault name internally
    -   You can rename the Google Drive folder without consequence
    -   You can also color the folder in Google Drive and place it wherever you please
    -   Each file in the vault is also tagged with the vault name inside Google Drive's properties
-   Each vault is connected to the Google Drive folder that has the same tag/internal name
    -   If you want multiple devices to sync to the same vault, the vault names must match
-   You can have multiple vaults per Google account by having local vaults with different names
    -   Do NOT rename local vaults that you are syncing to Google Drive
    -   Instead, make a new vault, sync it, and transfer your files over
    -   We will not add any implementation to automate this process because it inherently messes with other synced devices

Privacy Policy: [https://ogd.richardxiong.com/privacy](https://ogd.richardxiong.com/privacy)
