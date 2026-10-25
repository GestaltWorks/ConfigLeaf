# drift-lab: a throwaway host that stands in for a client host, reached as the ssh alias drift-lab
# (lab/ssh_config). Debian bookworm, nginx with two sites in sites-available linked from sites-enabled,
# the login "drift" with a sudo drop-in for what the write session runs and the read session's journal read,
# systemctl and journalctl stand-ins, a server-config export in /var/backups/export and one certbot renewal
# config. lab/up.sh builds and runs it.
FROM debian:bookworm-slim

# procps carries pgrep (the systemctl stand-in), iproute2 carries ip (the read script's address sections),
# python3 serves the upstream on 127.0.0.1:8081.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server nginx sudo tar gzip coreutils ca-certificates python3 procps iproute2 \
 && rm -rf /var/lib/apt/lists/*

# The login: a key from the mount (lab/entrypoint.sh), password field "*", sudo for exactly what the write session runs.
RUN useradd -m -s /bin/bash drift && usermod -p '*' drift
COPY sshd_config /etc/ssh/sshd_config.d/drift-lab.conf
COPY sudoers /etc/sudoers.d/drift-lab
RUN chmod 0440 /etc/sudoers.d/drift-lab && visudo -c -q

# systemd's place: the stand-in at /usr/local/bin (sudo's secure_path finds it first) and at /usr/bin
# (the read script's PATH, /usr/sbin:/usr/bin:/sbin:/bin).
COPY systemctl /usr/local/bin/systemctl
RUN chmod 0755 /usr/local/bin/systemctl && ln -s /usr/local/bin/systemctl /usr/bin/systemctl

# journald's place, the same way: the stand-in prints canned journal lines (lab/journalctl), which the read script
# reads through sudo -n.
COPY journalctl /usr/local/bin/journalctl
RUN chmod 0755 /usr/local/bin/journalctl && ln -sf /usr/local/bin/journalctl /usr/bin/journalctl

# nginx: Debian's nginx.conf and mime.types, the two lab sites, their web roots, the upstream's page.
COPY nginx/lab.example nginx/www.lab.test /etc/nginx/sites-available/
RUN rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-available/default \
 && ln -s /etc/nginx/sites-available/lab.example /etc/nginx/sites-enabled/lab.example \
 && ln -s /etc/nginx/sites-available/www.lab.test /etc/nginx/sites-enabled/www.lab.test \
 && install -d /var/www/lab /var/www/lab-test /var/www/upstream \
 && echo 'lab.example static root' > /var/www/lab/index.html \
 && echo 'www.lab.test' > /var/www/lab-test/index.html \
 && echo 'lab upstream on 127.0.0.1:8081' > /var/www/upstream/index.html \
 && nginx -t

# certbot's renewal config for lab.example: the config alone, as on a host whose certificate lives elsewhere.
COPY renewal/lab.example.conf /etc/letsencrypt/renewal/lab.example.conf
RUN chmod 0755 /etc/letsencrypt /etc/letsencrypt/renewal && chmod 0644 /etc/letsencrypt/renewal/lab.example.conf

# The export, as the operator's hosts write it nightly: server-config-<date>.tar.gz of etc/nginx and
# etc/letsencrypt, here taken once at image build, readable by the login.
RUN install -d -m 0755 /var/backups/export \
 && tar -czf "/var/backups/export/server-config-$(date -u +%Y-%m-%d).tar.gz" -C / etc/nginx etc/letsencrypt \
 && chmod 0644 /var/backups/export/*.tar.gz

COPY entrypoint.sh /usr/local/sbin/drift-lab-entrypoint
RUN chmod 0755 /usr/local/sbin/drift-lab-entrypoint
EXPOSE 22
ENTRYPOINT ["/usr/local/sbin/drift-lab-entrypoint"]
