"use strict";

const fs = require("fs");

function createAudit({ file, maxBytes = 5 * 1024 * 1024, keepLines = 2000 }) {
  function write(entry) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
      fs.appendFileSync(file, line);
      const st = fs.statSync(file);
      if (st.size > maxBytes) {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        fs.writeFileSync(file, lines.slice(-keepLines).join("\n") + "\n");
      }
    } catch (err) {
      /* auditing must never break the request */
    }
  }

  function tail(limit = 200) {
    try {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch (err) {
            return null;
          }
        })
        .filter(Boolean)
        .reverse();
    } catch (err) {
      return [];
    }
  }

  return { write, tail };
}

module.exports = { createAudit };
