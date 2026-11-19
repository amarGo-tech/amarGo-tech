import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";

const url = fs.readFileSync("server/.env", "utf8").match(/DATABASE_URL\s*=\s*"?([^"\n]+)"?/)[1];
const u = new URL(url);
const host = u.hostname;
const user = decodeURIComponent(u.username);
const pass = decodeURIComponent(u.password);
const db = u.pathname.slice(1);
console.log({ host, user, db, passLen: pass.length });

const raw = net.connect(5432, host, () => raw.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
raw.once("data", () => {
  const sock = tls.connect({ socket: raw, servername: host, rejectUnauthorized: false }, () => {
    // StartupMessage: int32 len, int32 protocol(196608), then key\0value\0 pairs, final \0
    const params = `user\0${user}\0database\0${db}\0application_name\0pg-probe\0\0`;
    const body = Buffer.concat([Buffer.from([0, 3, 0, 0]), Buffer.from(params, "utf8")]);
    const msg = Buffer.alloc(4 + body.length);
    msg.writeInt32BE(msg.length, 0);
    body.copy(msg, 4);
    sock.write(msg);
  });
  sock.on("data", (d) => {
    let o = 0;
    while (o < d.length) {
      const type = String.fromCharCode(d[o]);
      const len = d.readInt32BE(o + 1);
      const payload = d.slice(o + 5, o + 1 + len);
      if (type === "E" || type === "N") {
        const parts = payload.toString("utf8").split("\0").filter(Boolean);
        console.log(type === "E" ? "ERROR" : "NOTICE", parts);
      } else if (type === "R") {
        console.log("Auth request code", payload.readInt32BE(0));
      } else {
        console.log("msg type", type, "len", len);
      }
      o += 1 + len;
    }
    sock.end();
  });
  sock.on("error", (e) => console.log("TLS sock err", e.message));
  sock.on("end", () => console.log("server closed connection"));
});
raw.on("error", (e) => console.log("raw err", e.message));
raw.setTimeout(20000, () => { console.log("timeout"); raw.destroy(); });
