/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/* exported init */

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const GObject = imports.gi.GObject;
const WindowAttentionSource = imports.ui.windowAttentionHandler.WindowAttentionSource;

class PayAttentionExtension {
  constructor() {
    this._connections = [];
    this._highlights = new Set();
    this._newWindows = new Set();
    this._tracker = null;
    this.onWindowDemandsAttention = this.onWindowDemandsAttention.bind(this);
    this.onNewWindow = this.onNewWindow.bind(this);
    this.onRemoveWindow = this.onRemoveWindow.bind(this);
    this.onFocusChanged = this.onFocusChanged.bind(this);
  }

  enable() {
    this._connect(global.display, 'window-demands-attention', this.onWindowDemandsAttention, '_windowDemandsAttentionId');
    this._connect(global.display, 'window-marked-urgent', this.onWindowDemandsAttention, '_windowMarkedUrgentId');
    this._connect(global.display, 'notify::focus-window', this.onFocusChanged);
    this._connect(global.window_manager, 'map', this.onNewWindow);
    this._tracker = Main.windowAttentionHandler._tracker;
  }

  disable() {
    this._disconnectAll();
    this._highlights = {};
    this._newWindows.clear();
    this._tracker = null;
  }

  _connect(obj, eventName, receiver, originalId = false) {
    if (originalId) {
      obj.disconnect(Main.windowAttentionHandler[originalId]);
    }
    const connectionId = obj.connect(eventName, receiver);
    this._connections.push({ obj, eventName, originalId, connectionId });
  }

  _disconnectFrom(obj, eventName) {
    for (let i = this._connections.length - 1; i >= 0; --i) {
      const conn = this._connections[i];
      if (conn.obj == obj && (!eventName || eventName == conn.eventName)) {
        obj.disconnect(conn.connectionId);
        this._connections.splice(i, 1);
      }
    }
  }

  _disconnectAll() {
    const originalHandler = Main.windowAttentionHandler._onWindowDemandsAttention.bind(Main.windowAttentionHandler);
    for (const conn of this._connections) {
      global.display.disconnect(conn.connectionId);
      if (conn.originalId) {
        Main.windowAttentionHandler[conn.originalId] = conn.obj.connect(eventName, originalHandler);
      }
    }
    this._connections = [];
  }

  onNewWindow(shellwm, actor) {
    const win = actor.meta_window;
    this._connect(win, 'unmanaged', this.onRemoveWindow);
    this._newWindows.add(win);
  }

  onRemoveWindow(win) {
    this._newWindows.remove(win);
    this._disconnectFrom(win);
  }

  _getAppIcons(dash) {
    if (!dash) {
      // No dash, somehow
      return [];
    }
    if (dash.getAppIcons) {
      // Dash to Dock
      return dash.getAppIcons();
    }
    // Default dash
    return dash._box.get_children().filter(actor => {
      return actor.child &&
        actor.child._delegate &&
        actor.child._delegate.icon &&
        !actor.animatingOut;
    }).map(actor => actor.child._delegate);
  }

  onFocusChanged() {
    const app = this._tracker.focus_app;
    const appId = app.get_id();
    this._clearUrgent(appId);
  }

  onWindowDemandsAttention(display, window) {
    if (!window || window.has_focus() || window.is_skip_taskbar()) {
      // If the window doesn't exist or already has the focus, there's no action necessary.
      return;
    }

    if (this._newWindows.has(window)) {
      // GNOME considers mapping a new window to be a demand for attention, and
      // there's no way to discriminate between the cases except to keep track
      // of all new windows being created. Therefore, if this is the first time
      // a newly-mapped window has requested attention, focus it -- don't leave
      // it concealed on the bottom of the stack.
      this._newWindows.delete(window);
      Main.activateWindow(window);
      return;
    }

    const app = this._tracker.get_window_app(window);
    const appId = app.get_id();
    const source = this.createNotification(app, window);
    source._sync = this._syncNotification.bind(this, appId, source);

    if (!this._highlights.has(appId)) {
      this._highlights.add(appId);
      const appIcons = this._getAppIcons(Main.overview.dash);
      const icon = appIcons.find(icon => icon.app && icon.app.get_id() == appId);
      if (icon) {
        icon.add_style_class_name('urgent');
      }
    }
  }

  createNotification(app, window) {
    const source = new WindowAttentionSource(app, window);
    const [title, banner] = Main.windowAttentionHandler._getTitleAndBanner(app, window);

    const notification = new MessageTray.Notification(source, title, banner);
    notification.connect('activated', () => {
      source.open();
    });
    notification.setForFeedback(true);

    source.showNotification(notification);

    source.signalIDs.push(window.connect('notify::title', () => {
      const [title, banner] = Main.windowAttentionHandler._getTitleAndBanner(app, window);
      notification.update(title, banner);
    }));

    return source;
  }

  _syncNotification(appId, source) {
    if (source._window.demands_attention || source._window.urgent) {
      return;
    }
    this._clearUrgent(appId);
    source.destroy();
  }

  _clearUrgent(appId) {
    if (!this._highlights.has(appId)) {
      return;
    }
    this._highlights.delete(appId);
    const appIcons = this._getAppIcons(Main.overview.dash);
    const icon = appIcons.find(icon => icon.app && icon.app.get_id() == appId);
    if (icon) {
      icon.remove_style_class_name('urgent');
    }
  }
}

function init() {
  return new PayAttentionExtension();
}
