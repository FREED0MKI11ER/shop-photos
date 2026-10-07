"use strict";

const path = require("path");
const { Service } = require("node-windows");

const SERVICE_NAME = process.env.SERVICE_NAME || "ShopMediaShare";
const ROOT = path.join(__dirname, "..");

const svc = new Service({
  name: SERVICE_NAME,
  script: path.join(ROOT, "server.js"),
});

svc.on("uninstall", () => {
  console.log("Service uninstalled.");
});

svc.on("error", (err) => {
  console.error("Service error:", err);
  process.exitCode = 1;
});

svc.uninstall();
