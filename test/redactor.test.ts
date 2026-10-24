import { describe, expect, it } from "vitest";
import { Redactor, describeRedactions } from "../src/redactor.ts";

const r = new Redactor("test-salt");
const H6 = "[0-9a-f]{6}";

// Synthetic shapes only. The Cloudflare token and key are the right length and alphabet, nothing more. The domain
// is invented and was checked unregistered on 2026-10-23 (RDAP lookup at rdap.verisign.com returned 404).
const CF_TOKEN = "vK3mN8pQ2rS5tU7wX9yZ1aB4cD6eF8gH0iJ2kL4m"; // 40: Cloudflare API token
const CF_KEY = "a3f9c2e1d4b7865409fedcba1234567890abc"; // 37 hex: Cloudflare legacy global key
const SHA = "9c1f0a3d".repeat(8); // 64 hex: a restic id, a value_hash
const CF_ID = "6a4f3b2c1d0e9f8a".repeat(2); // 32 hex: a Cloudflare object id
const KEY_BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIGx7Zq1cR3mP0vQ8sT2uW4xY6zA8bC0dE2fG4hI6jK8l"; // 68: ed25519 public key shape

const nginx = `server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name portal.bluefin-logistics-zz9q.com www.bluefin-logistics-zz9q.com;
    ssl_certificate /etc/letsencrypt/live/portal.bluefin-logistics-zz9q.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/portal.bluefin-logistics-zz9q.com/privkey.pem;
    access_log /var/log/nginx/portal.bluefin-logistics-zz9q.com.access.log main;
    include /etc/nginx/mime.types;
    allow 10.40.0.0/16;
    allow 203.0.113.0/24;
    deny all;
    location / {
        proxy_pass http://app.bluefin-logistics-zz9q.com:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Authorization "Bearer ${CF_TOKEN}";
    }
    location /api {
        proxy_pass http://10.40.12.7:9000;
    }
}
`;

const sudoers = `# drift-collector: root reads only
Host_Alias OPS = 10.40.0.0/16, bastion.bluefin-logistics-zz9q.com
Cmnd_Alias DRIFT_READ = /usr/sbin/nginx -T, /usr/bin/cat /etc/nginx/*, /usr/bin/etckeeper vcs log -n 50
Defaults:drift-collector !requiretty
drift-collector OPS = (root) NOPASSWD: DRIFT_READ
jmorales ALL = (ALL:ALL) PASSWD: /usr/bin/less /home/jmorales/notes.txt
`;

const audit = {
  id: CF_ID,
  action: { type: "rec_set", result: true },
  actor: { email: "ops.lead@bluefin-logistics-zz9q.com", id: "0f1e2d3c4b5a6978".repeat(2), ip: "100.72.5.19", type: "user" },
  interface: "API",
  metadata: {
    "zone.name": "bluefin-logistics-zz9q.com",
    headers: { Authorization: `Bearer ${CF_TOKEN}`, "X-Auth-Key": CF_KEY, "X-Auth-Email": "ops.lead@bluefin-logistics-zz9q.com" },
  },
  newValue: { name: "app.bluefin-logistics-zz9q.com", type: "A", content: "100.98.3.44", ttl: 300, proxied: false },
  oldValue: { name: "app.bluefin-logistics-zz9q.com", type: "A", content: "10.40.12.7" },
  resource: { type: "DNS_record", id: "372e67954025e0ba6aaa6d586b9e0b59" },
  when: "2026-10-21T14:03:11Z",
};

const restic = [{
  time: "2026-10-20T02:00:03.511Z",
  parent: SHA,
  tree: SHA.split("").reverse().join(""),
  paths: ["/etc", "/home/jmorales", "/home/svc-deploy/.config"],
  hostname: "web-01.bluefin-logistics-zz9q.com",
  username: "root",
  id: SHA,
  short_id: SHA.slice(0, 8),
}];

describe("Redactor", () => {
  it("nginx vhost: directives survive, hosts and addresses are pseudonymised, the bearer token is a placeholder", () => {
    const out = r.text(nginx);
    expect(out).not.toMatch(/bluefin|10\.40\.|vK3mN8/);
    for (const kept of [
      "listen [::]:443 ssl http2;", "allow 203.0.113.0/24;", "deny all;", "proxy_set_header Host $host;",
      "ssl_certificate_key /etc/letsencrypt/live/", "/fullchain.pem;", "/privkey.pem;", ".access.log main;", "include /etc/nginx/mime.types;",
    ]) expect(out).toContain(kept);
    expect(out).toMatch(new RegExp(`allow ip-${H6}/16;`));
    expect(out).toMatch(new RegExp(`proxy_pass http://host-${H6}\\.com:8080;`));
    expect(out).toMatch(new RegExp(`proxy_pass http://ip-${H6}:9000;`));
    expect(out).toMatch(/Authorization "Bearer <secret:bearer:[0-9a-f]{8}>";/);
    const names = out.match(new RegExp(`server_name (host-${H6}\\.com) (host-${H6}\\.com);`))!;
    expect(names[1]).not.toBe(names[2]);
    expect(out.split(names[1]).length - 1).toBe(4); // server_name, two certificate paths, access_log stem
  });

  it("authorized_keys: options and key type survive, the key blob and the comment identity do not", () => {
    const line = `command="/usr/local/bin/drift-collect",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 ${KEY_BLOB} jmorales@ops.bluefin-logistics-zz9q.com`;
    const out = r.text(line);
    expect(out.startsWith('command="/usr/local/bin/drift-collect",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 <secret:b64:')).toBe(true);
    expect(out).toMatch(new RegExp(` mail-${H6}@domain-${H6}$`));
    expect(out).not.toContain("AAAAC3");
  });

  it("sudoers: every line still parses; NOPASSWD and PASSWD tags are syntax, not secrets", () => {
    const out = r.text(sudoers);
    const grammar = [
      /^#/,
      /^Host_Alias\s+\w+\s*=\s*\S.*$/,
      /^Cmnd_Alias\s+\w+\s*=\s*\S.*$/,
      /^Defaults(?::\S+)?\s+\S.*$/,
      /^\S+\s+\S+\s*=\s*\(\S+\)\s*(?:NO)?PASSWD:\s*\S.*$/,
    ];
    for (const line of out.split("\n").filter(Boolean)) expect(grammar.some((g) => g.test(line)), line).toBe(true);
    expect(out).toContain("NOPASSWD: DRIFT_READ");
    expect(out).toContain("PASSWD: /usr/bin/less /home/user-");
    expect(out).toContain("/usr/sbin/nginx -T, /usr/bin/cat /etc/nginx/*");
    expect(out).toMatch(new RegExp(`Host_Alias OPS = ip-${H6}/16, host-${H6}\\.com`));
    expect(out).not.toContain("<secret:");
  });

  it("Cloudflare audit event: keys, booleans, ids and timestamps survive; actor, addresses, hosts and header secrets do not", () => {
    const out = r.json(audit);
    expect(Object.keys(out.metadata.headers)).toEqual(["Authorization", "X-Auth-Key", "X-Auth-Email"]);
    expect(out.id).toBe(audit.id);
    expect(out.actor.id).toBe(audit.actor.id);
    expect(out.resource).toEqual(audit.resource);
    expect(out.action).toEqual(audit.action);
    expect(out.when).toBe(audit.when);
    expect(out.newValue.ttl).toBe(300);
    expect(out.newValue.proxied).toBe(false);
    expect(out.metadata["zone.name"]).toMatch(new RegExp(`^host-${H6}\\.com$`));
    expect(out.actor.email).toMatch(new RegExp(`^mail-${H6}@domain-${H6}$`));
    expect(out.metadata.headers["X-Auth-Email"]).toBe(out.actor.email);
    expect(out.actor.ip).toMatch(new RegExp(`^ip-${H6}$`));
    expect(out.metadata.headers.Authorization).toMatch(/^Bearer <secret:bearer:[0-9a-f]{8}>$/);
    expect(out.metadata.headers["X-Auth-Key"]).toMatch(/^<secret:kv:[0-9a-f]{8}>$/);
    expect(out.oldValue.content).toBe(r.text("10.40.12.7")); // the address in the nginx vhost is the same pseudonym here
    expect(out.newValue.name).toBe(out.oldValue.name);
    expect(JSON.stringify(out)).not.toMatch(/bluefin|vK3mN8|a3f9c2|100\.72|100\.98|10\.40/);
  });

  it("restic snapshot listing: ids and times survive, /home paths and the hostname are pseudonymised", () => {
    const [out] = r.json(restic);
    expect(out.id).toBe(SHA);
    expect(out.parent).toBe(SHA);
    expect(out.tree).toBe(restic[0].tree);
    expect(out.short_id).toBe(restic[0].short_id);
    expect(out.time).toBe(restic[0].time);
    expect(out.paths[0]).toBe("/etc");
    expect(out.paths[1]).toMatch(new RegExp(`^/home/user-${H6}$`));
    expect(out.paths[2]).toMatch(new RegExp(`^/home/user-${H6}/\\.config$`));
    expect(out.hostname).toMatch(new RegExp(`^host-${H6}\\.com$`));
    // same login, same suffix: the home directory and the mail address stay linkable inside one salt
    const suffix = out.paths[1].slice("/home/user-".length);
    expect(r.text("jmorales@bluefin-logistics-zz9q.com")).toMatch(new RegExp(`^mail-${suffix}@domain-${H6}$`));
  });

  it("secret shapes become <secret:KIND:hash>; the key or envelope that names them survives", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
    expect(r.text(pem)).toMatch(/^<secret:pem:[0-9a-f]{8}>$/);
    expect(r.text("aws_access_key_id = AKIAIOSFODNN7EXAMPLE")).toMatch(/^aws_access_key_id = <secret:aws_key:[0-9a-f]{8}>$/);
    expect(r.text(`METERLESS_RUNTIME_TOKEN=rt-${"k".repeat(24)}`)).toMatch(/^METERLESS_RUNTIME_TOKEN=<secret:kv:[0-9a-f]{8}>$/);
    expect(r.text(`token rt-${"k".repeat(24)}`)).toMatch(/^token <secret:rt:[0-9a-f]{8}>$/);
    expect(r.text(`curl -H 'X-Key: nvapi-${"q".repeat(32)}'`)).toMatch(/^curl -H 'X-Key: <secret:nvapi:[0-9a-f]{8}>'$/);
    expect(r.text('{"client_secret": "hunter2-hunter2", "password": "pa55", "api_key": "k"}'))
      .toMatch(/^\{"client_secret": "<secret:kv:[0-9a-f]{8}>", "password": "<secret:kv:[0-9a-f]{8}>", "api_key": "<secret:kv:[0-9a-f]{8}>"\}$/);
    expect(r.text(`Authorization: ${CF_TOKEN}`)).toMatch(/^Authorization: <secret:cf_token:[0-9a-f]{8}>$/);
    expect(r.text(`X-Auth-Key: ${CF_KEY}`)).toMatch(/^X-Auth-Key: <secret:kv:[0-9a-f]{8}>$/);
    expect(r.text(`HMAC key ${SHA}`)).toMatch(/^HMAC key <secret:hex:[0-9a-f]{8}>$/);
    expect(r.text(`ssh-rsa ${KEY_BLOB}`)).toMatch(/^ssh-rsa <secret:b64:[0-9a-f]{8}>$/);
    // a long hash with no key-like neighbour is data: etckeeper commits, restic ids, value_hash
    expect(r.text(`commit ${"3f2a1b0c7d".repeat(4)}\nAuthor: root`)).toContain(`commit ${"3f2a1b0c7d".repeat(4)}`);
    expect(r.text(`"value_hash": "${SHA}"`)).toBe(`"value_hash": "${SHA}"`);
  });

  it("value(): a lone token-shaped value has no key-like neighbour, so the whole value is the secret", () => {
    expect(r.value(CF_TOKEN)).toMatch(/^<secret:value:[0-9a-f]{8}>$/);
    expect(r.value(SHA)).toMatch(/^<secret:value:[0-9a-f]{8}>$/);
    expect(r.value("app.bluefin-logistics-zz9q.com")).toMatch(new RegExp(`^host-${H6}\\.com$`));
    expect(r.value("v=spf1 include:_spf.example.com ~all")).toBe("v=spf1 include:_spf.example.com ~all");
  });

  it("documentation, loopback and unspecified addresses pass through; everything else is a stable pseudonym", () => {
    for (const ip of ["192.0.2.1", "198.51.100.77", "203.0.113.200", "127.0.0.1", "0.0.0.0", "::1", "::", "2001:db8::1"]) {
      expect(r.text(`addr ${ip} end`)).toBe(`addr ${ip} end`);
    }
    for (const ip of ["10.0.0.1", "172.16.4.9", "192.168.1.1", "100.64.0.1", "fd00::5", "2a02:1234:5678::9"]) {
      expect(r.text(ip)).toMatch(new RegExp(`^ip-${H6}$`));
    }
    expect(r.text("10.0.0.1")).toBe(new Redactor("test-salt").text("10.0.0.1"));
    expect(r.text("10.0.0.1")).not.toBe(r.text("10.0.0.2"));
    expect(r.text("nginx/1.24.0 and 12:30:45 and aa:bb:cc:dd:ee:ff")).toBe("nginx/1.24.0 and 12:30:45 and aa:bb:cc:dd:ee:ff");
  });

  it("reserved names pass through; other hostnames keep only their TLD; file names are not hostnames", () => {
    for (const h of ["db.example.com", "app.example", "lab.test", "nothing.invalid", "example.org"]) expect(r.text(h)).toBe(h);
    expect(r.text("Db.Bluefin-Logistics-zz9q.COM")).toBe(r.text("db.bluefin-logistics-zz9q.com").replace(".com", ".COM"));
    for (const f of ["nginx.conf", "mime.types", "error.log", "id_ed25519.pub", "fullchain.pem", "getty@tty1.service"]) expect(r.text(f)).toBe(f);
    expect(r.text("sites-enabled/portal.bluefin-logistics-zz9q.com.conf")).toMatch(new RegExp(`^sites-enabled/host-${H6}\\.com\\.conf$`));
    expect(r.text("root@203.0.113.5 and root@web-01 and root@10.9.8.7")).toMatch(new RegExp(`^user-${H6}@203\\.0\\.113\\.5 and user-${H6}@host-${H6} and user-${H6}@ip-${H6}$`));
  });

  it("the agent's own vocabulary is not a host: surfaces, setting paths, SQL aliases and a datasource-qualified table stay; a trailing period still redacts", () => {
    for (const s of [
      "linux.nginx host-7f1c: 2/2 complete",
      "cloudflare.dns: 3/3 complete",
      "server.location./.proxy_pass in /etc/nginx/conf.d/app.conf on host-7f1c",
      "server.listen and http.upstream.app.server and events.worker_connections",
      "SELECT o.host, o.object_id, d.name, d.content, i.address, e2.actor FROM observation o JOIN DRIFT.observation x ON x.obs_id = o.obs_id",
      "run_complete run-nginx-2b9e-1023",
    ]) expect(r.text(s)).toBe(s);
    expect(r.text("see bluefin-logistics-zz9q.com.")).toMatch(new RegExp(`^see host-${H6}\\.com\\.$`));
    expect(r.text("portal.bluefin-logistics-zz9q.com/healthz")).toMatch(new RegExp(`^host-${H6}\\.com/healthz$`));
  });

  it("deterministic per salt; a different salt gives different pseudonyms with the same shape", () => {
    const a = new Redactor("salt-a");
    const b = new Redactor("salt-b");
    expect(a.text(nginx)).toBe(new Redactor("salt-a").text(nginx));
    expect(a.text(nginx)).not.toBe(b.text(nginx));
    expect(describeRedactions(nginx, a.text(nginx))).toEqual(describeRedactions(nginx, b.text(nginx)));
  });

  it("redacting redacted output is a no-op", () => {
    for (const s of [r.text(nginx), r.text(sudoers), r.text(`${CF_KEY} /home/jmorales ops@bluefin-logistics-zz9q.com Bearer ${CF_TOKEN}`)]) expect(r.text(s)).toBe(s);
    expect(r.json(r.json(audit))).toEqual(r.json(audit));
    expect(r.json(r.json(restic))).toEqual(r.json(restic));
  });

  it("describeRedactions counts what changed, per kind, for the trace line", () => {
    const before = `proxy_pass http://app.bluefin-logistics-zz9q.com; allow 10.1.1.1; allow 10.1.1.2; Authorization: Bearer ${CF_TOKEN}`;
    expect(describeRedactions(before, r.text(before))).toEqual({ bearer: 1, ip: 2, host: 1 });
    expect(describeRedactions(nginx, nginx)).toEqual({});
    expect(describeRedactions(nginx, r.text(nginx))).toEqual({ bearer: 1, ip: 2, host: 6 });
  });
});
