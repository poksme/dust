#!/usr/bin/env node

import { render } from "ink";
import meow from "meow";
import React from "react";
import updateNotifier from "update-notifier";

import pkg from "../package.json" with { type: "json" };
import App from "./ui/App.js"; 

updateNotifier({
  pkg,
  updateCheckInterval: 1000 * 60 * 60 * 24, // 24 hours
}).notify({
  isGlobal: true,
  message:
    "Update available {currentVersion} → {latestVersion}\nRun {updateCommand} to update",
});

const cli = meow({
  importMeta: import.meta,
  autoHelp: false,
  flags: {
    version: {
      type: "boolean",
      shortFlag: "v",
    },
    force: {
      type: "boolean",
      shortFlag: "f",
    },
    help: {
      type: "boolean",
    },
    port: {
      type: "number",
      shortFlag: "p",
      description: "Specify the port for the MCP server",
    },
    sId: {
      type: "string",
      shortFlag: "s",
      isMultiple: true,
      description: "Specify agent sId(s) to use directly (can be repeated)",
    },
    agent: {
      type: "string",
      shortFlag: "a",
      description: "Search for and use an agent by name",
    },
    message: {
      type: "string",
      shortFlag: "m",
      description: "Send a message to the agent non-interactively",
    },
  },
});

render(<App cli={cli} />);
