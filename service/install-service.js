"use strict";

const path = require("path");
const fs = require("fs");
const { Service } = require("node-windows");

const SERVICE_NAME = process.env.SERVICE_NAME || "ShopMediaShare";
const PORT = process.env.PORT || "3000";
const ROOT = path.join(__dirname, "..");

const bundledNode = path.join(ROOT, "runtime", "node", "node.exe");
const execPath = fs.existsSync(bundledNode) ? bundledNode : process.execPath;

console.log(`Installing service "${SERVICE_NAME}" on port ${PORT}`);
console.log(`Node executable: ${execPath}`);

const svc = new Service({
  name: SERVICE_NAME,
  description: "Shop photo/video file share on the local network",
  script: path.join(ROOT, "server.js"),
  workingDirectory: ROOT,
  execPath,
  env: [
    { name: "PORT", value: String(PORT) },
    { name: "NODE_ENV", value: "production" },
  ],
  wait: 2,
  grow: 0.5,
  maxRestarts: 10,
});

svc.on("install", () => {
  console.log("Service installed. Starting it now...");
  svc.start();
});

svc.on("alreadyinstalled", () => {
  console.log("Service is already installed. Remove it first to reinstall.");
});

svc.on("start", () => {
  console.log("Service started. It will now run automatically on boot.");
});

svc.on("error", (err) => {
  console.error("Service error:", err);
  process.exitCode = 1;
});

svc.install();
