'use strict';
/** A small stand-in for the `vscode` module: configuration, commands, tabs, terminals. */
let state;
function reset() {
  state = { config: {}, updates: [], commands: [], tabs: [], closed: [], terminals: [], info: [], isTrusted: true,
            commandImpl: {} };
}
reset();
function current() {
  return {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    TerminalLocation: { Editor: 2, Panel: 1 },
    ViewColumn: { Active: -1 },
    workspace: {
      get isTrusted() { return state.isTrusted; },
      workspaceFolders: state.folders || [],
      getConfiguration(section) {
        return {
          get: (k) => state.config[section + '.' + k],
          update: async (k, v, target) => { state.updates.push({ key: section + '.' + k, value: v, target });
                                            if (v === undefined) delete state.config[section + '.' + k];
                                            else state.config[section + '.' + k] = v; },
        };
      },
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: {
      executeCommand: async (cmd, ...args) => { state.commands.push([cmd, ...args]);
                                                if (state.commandImpl[cmd]) return state.commandImpl[cmd](...args); },
      registerCommand: () => ({ dispose() {} }),
    },
    window: {
      tabGroups: {
        get all() { return [{ tabs: state.tabs }]; },
        close: async (tabs) => { for (const t of [].concat(tabs)) { state.closed.push(t.label);
                                  state.tabs = state.tabs.filter(x => x !== t); } return true; },
      },
      createTerminal: (o) => { const t = { opts: o, show() {}, sendText(x) { this.sent = x; } }; state.terminals.push(t); return t; },
      showInformationMessage: (m) => { state.info.push(m); },
      showWarningMessage: (m) => { state.info.push(m); },
    },
  };
}
module.exports = { current, reset, get state() { return state; } };
