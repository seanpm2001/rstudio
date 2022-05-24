/*
 * desktop-browser-window.ts
 *
 * Copyright (C) 2022 by RStudio, PBC
 *
 * Unless you have received this program directly from RStudio pursuant
 * to the terms of a commercial license agreement with RStudio, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */

import { BrowserWindow, shell, WebContents } from 'electron';
import { IpcMainEvent } from 'electron/main';

import path from 'path';

import { EventEmitter } from 'stream';
import { URL } from 'url';
import { logger } from '../core/logger';
import { appState } from './app-state';
import { showContextMenu } from './context-menu';
import { ElectronDesktopOptions } from './preferences/electron-desktop-options';
import { ToolbarData, ToolbarManager } from './toolbar-manager';
import { executeJavaScript, handleLocaleCookies, isSafeHost } from './utils';

// This allows TypeScript to pick up the magic constants auto-generated by Forge's Webpack
// plugin that tells the Electron app where to look for the Webpack-bundled app code (depending on
// whether you're running in development or production).
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

export interface WindowConstructorOptions {
  /** Display a navigation toolbar; default is `false` */
  showToolbar?: boolean;

  /** Sync the window's title with the web content's title; default is `false` */
  adjustTitle?: boolean;

  /** Hide the menubar unless activated via Alt key; Default is `false` */
  autohideMenu?: boolean;

  /** Internal identifier for the window */
  name: string;

  /**
   * REVIEW: compare this against the Qt sources to determine we're using it as intended
   */
  baseUrl?: string;

  /** Parent of this window, if any */
  parent?: DesktopBrowserWindow;

  /** Web content that opened this window, if any */
  opener?: WebContents;

  /** Allow navigation to external domains; default is `false` */
  allowExternalNavigate?: boolean;

  /** Callbacks to attach to the window; default is `desktopInfo` */
  addApiKeys?: string[];

  /** Attach to this `BrowserWindow` instead of creating a new one */
  existingWindow?: BrowserWindow;
}

/**
 * Base class for browser-based windows. Subclasses include GwtWindow, SecondaryWindow,
 * SatelliteWindow, and MainWindow.
 *
 * Porting note: This corresponds to a combination of the QMainWindow/BrowserWindow and
 * QWebEngineView/WebView in the Qt desktop app.
 */
export class DesktopBrowserWindow extends EventEmitter {
  static WINDOW_DESTROYED = 'desktop-browser-window_destroyed';
  static CLOSE_WINDOW_SHORTCUT = 'desktop-browser-close_window_shortcut';

  window: BrowserWindow;

  // if loading fails and emits `did-fail-load` it will be followed by a
  // 'did-finish-load'; use this bool to differentiate
  private failLoad = false;

  constructor(protected options: WindowConstructorOptions) {
    super();

    // set defaults for optional constructor arguments
    this.options.showToolbar = this.options.showToolbar ?? false;
    this.options.adjustTitle = this.options.adjustTitle ?? false;
    this.options.autohideMenu = this.options.autohideMenu ?? false;
    this.options.allowExternalNavigate = this.options.allowExternalNavigate ?? false;

    const apiKeys = [['--api-keys=desktopInfo', ...(this.options.addApiKeys ?? [])].join('|')];

    if (this.options.existingWindow) {
      this.window = this.options.existingWindow;
    } else {
      const preload = DesktopBrowserWindow.getPreload();

      this.window = new BrowserWindow({
        // https://github.com/electron/electron/blob/master/docs/faq.md#the-font-looks-blurry-what-is-this-and-what-can-i-do
        backgroundColor: '#fff',
        autoHideMenuBar: this.options.autohideMenu,
        webPreferences: {
          additionalArguments: apiKeys,
          contextIsolation: true,
          nodeIntegration: false,
          preload: preload,
          sandbox: true,
        },
        show: false,
        acceptFirstMouse: true,
      });

      void handleLocaleCookies(this.window, true);

      const customStyles =
        // eslint-disable-next-line max-len
        '.gwt-SplitLayoutPanel-HDragger{cursor:ew-resize !important;} .gwt-SplitLayoutPanel-VDragger{cursor:ns-resize !important;}';

      this.window.webContents
        .insertCSS(customStyles, {
          cssOrigin: 'author',
        })
        .then((result) => {
          logger().logDebug('Custom Styles Added Successfully');
        })
        .catch((error) => {
          logger().logError(error);
        });

      // Uncomment to have all windows show dev tools by default
      // this.window.webContents.openDevTools();
    }

    // register context menu (right click) handler
    this.window.webContents.on('context-menu', (event, params) => {
      showContextMenu(event as IpcMainEvent, params);
    });

    this.window.webContents.on('before-input-event', (event, input) => {
      this.keyPressEvent(event, input);
    });

    this.window.webContents.setWindowOpenHandler((details) => {
      // check if this is target="_blank" from an IDE window
      if (
        this.options.baseUrl &&
        (details.disposition === 'foreground-tab' || details.disposition === 'background-tab')
      ) {
        // TODO: validation/restrictions on the URLs?
        void shell.openExternal(details.url);
        return { action: 'deny' };
      }

      // configure window creation; we'll associate the resulting BrowserWindow with our
      // window wrapper type via 'did-create-window' below
      return appState().windowOpening();
    });

    this.window.webContents.on('did-create-window', (newWindow) => {
      appState().windowCreated(newWindow, this.window.webContents, this.options.baseUrl);
    });

    this.window.webContents.on('will-navigate', (event, url) => {
      // TODO: this is a partial implementation of DesktopWebPage.cpp::acceptNavigationRequest;
      // all the other details need to be implemented

      let targetUrl: URL;
      try {
        targetUrl = new URL(url);
      } catch (err: unknown) {
        // malformed URL will cause exception
        logger().logError(err);
        event.preventDefault();
        return;
      }

      // determine if this is a local request (handle internally only if local)
      const host = targetUrl.hostname;
      const isLocal = host === 'localhost' || host == '127.0.0.1' || host == '::1';
      if (isLocal) {
        return;
      }

      if (!this.options.allowExternalNavigate) {
        try {
          const targetUrl: URL = new URL(url);
          if (!isSafeHost(targetUrl.host)) {
            // when not allowing external navigation, open an external browser
            // to view the URL
            event.preventDefault();
            void shell.openExternal(url);
          }
        } catch (err: unknown) {
          // malformed URL will cause exception
          logger().logError(err);
          event.preventDefault();
        }
      }
    });

    this.window.webContents.on('page-title-updated', (event, title, explicitSet) => {
      this.adjustWindowTitle(title, explicitSet);
    });

    this.window.webContents.on('did-finish-load', () => {
      if (this.options.showToolbar) {
        const toolbarManager = new ToolbarManager();

        const toolbarData: ToolbarData = {
          buttons: [
            {
              tooltip: 'Go Back',
              iconPath: path.join(__dirname, 'assets', 'img', 'back.png'),
              onClick: `()=> {
                history.back();
              }`,
            },
            {
              tooltip: 'Go Forward',
              iconPath: path.join(__dirname, 'assets', 'img', 'forward.png'),
              onClick: `()=> {
                history.forward();
              }`,
            },
            {
              tooltip: 'Refresh Page',
              iconPath: path.join(__dirname, 'assets', 'img', 'reload.png'),
              onClick: `()=> {
                window.location.reload();
              }`,
            },
          ],
        };

        toolbarManager.createAndShowToolbar(this.window, toolbarData).catch((err) => {
          console.error('Error when trying to add Secondary Window toolbar', err);
        });
      }

      if (!this.failLoad) {
        this.finishLoading(true);
      } else {
        this.failLoad = false;
      }
    });

    this.window.webContents.on('did-fail-load', () => {
      this.failLoad = true;
      this.finishLoading(false);
    });

    if (!this.options.name.includes('satellite')) {
      this.window.on('close', (event: Electron.Event) => {
        this.closeEvent(event);
      });
    }

    this.window.on('closed', () => {
      this.emit(DesktopBrowserWindow.WINDOW_DESTROYED);
    });

    this.window.on('ready-to-show', () => {
      // set zoom factor when window is ready
      // https://github.com/electron/electron/issues/10572
      const zoomLevel = ElectronDesktopOptions().zoomLevel();
      this.window.webContents.setZoomFactor(zoomLevel);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  closeEvent(event: Electron.Event): void {
    if (!this.options.opener) {
      // if we don't know where we were opened from, check window.opener
      // (note that this could also be empty)
      const cmd = `if (window.opener && window.opener.unregisterDesktopChildWindow)
           window.opener.unregisterDesktopChildWindow('${this.options.name}');`;
      this.executeJavaScript(cmd).catch((error) => {
        logger().logError(error);
      });
    } else {
      // if we do know where we were opened from and it has the appropriate
      // handlers, let it know we're closing
      const cmd = `if (window.unregisterDesktopChildWindow)
           window.unregisterDesktopChildWindow('${this.options.name}');`;
      this.executeJavaScript(cmd).catch((error) => {
        logger().logError(error);
      });
    }
  }

  adjustWindowTitle(title: string, explicitSet: boolean): void {
    if (this.options.adjustTitle && explicitSet) {
      this.window.setTitle(title);
    }
  }

  syncWindowTitle(): void {
    if (this.options.adjustTitle) {
      this.window.setTitle(this.window.webContents.getTitle());
    }
  }

  finishLoading(succeeded: boolean): void {
    if (succeeded) {
      this.syncWindowTitle();

      // TODO: Qt version sets up a tiny resize of the window here in response to the
      // window being shown on a different screen. Need to test if this is necessary.

      const cmd = `if (window.opener && window.opener.registerDesktopChildWindow)
         window.opener.registerDesktopChildWindow('${this.options.name}', window);`;
      this.executeJavaScript(cmd).catch((error) => {
        logger().logError(error);
      });
    }
  }

  avoidMoveCursorIfNecessary(): void {
    if (process.platform === 'darwin') {
      this.executeJavaScript('document.body.className = document.body.className + " avoid-move-cursor"').catch(
        (error) => {
          logger().logError(error);
        },
      );
    }
  }

  /**
   * Execute javascript in this window's page
   *
   * @param cmd javascript to execute in this window
   * @returns promise with result of execution
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async executeJavaScript(cmd: string): Promise<any> {
    return executeJavaScript(this.window.webContents, cmd);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setViewerUrl(url: string): void {
    // TODO: in the Qt version this is implemented in webPage()
  }

  keyPressEvent(event: Electron.Event, input: Electron.Input): void {
    if (process.platform === 'darwin') {
      if (input.meta && input.key.toLowerCase() === 'w') {
        // on macOS, intercept Cmd+W and emit the window close signal
        this.emit(DesktopBrowserWindow.CLOSE_WINDOW_SHORTCUT);
      }
    }
  }

  /**
   *
   * @returns Path to preload script
   */
  static getPreload(): string {
    try {
      return MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY;
    } catch (err: unknown) {
      // manually specify preload (necessary when running unit tests)
      return path.join(__dirname, '../renderer/preload.js');
    }
  }
}
