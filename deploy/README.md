# Deployment

Live at **https://jeetcheck.<YOUR-IP>.sslip.io**

sslip.io automatically resolves `<anything>.<YOUR-IP>.sslip.io` to
<YOUR-IP>: no DNS record to create.

## Files

| file | destination |
|---|---|
| `jeetcheck.service` | `/etc/systemd/system/` |
| `nginx-jeetcheck.conf` | `/etc/nginx/sites-available/jeetcheck` then symlink into `sites-enabled/` |
| `jeetcheck-limits.conf` | `/etc/nginx/conf.d/` |

```bash
systemctl daemon-reload && systemctl enable --now jeetcheck
nginx -t && systemctl reload nginx
certbot --nginx -d jeetcheck.<YOUR-IP>.sslip.io
```

## Why these settings

**`proxy_read_timeout 300s` on `/api/analyze`.** A cold analysis takes about
90 seconds: 30 peaks verified against GeckoTerminal 2.5 s apart, plus around
sixty GMGN calls. A short timeout would cut it off mid-calculation and return
a 504 while everything is going fine.

**Limit of 6 requests per minute on `/api/analyze`.** Every cold analysis
consumes the GMGN quota (yours) and GeckoTerminal's, both shared. A burst from
a single IP would exhaust them for everyone. Verified 2026-08-25: four 200s
then 429s, with the page continuing to be served normally. Pages and logos
cost nothing and keep a wide limit.

**Port 8932.** 8910 was already taken by the Intel API in production. Don't
go back to it.

## To close access

```bash
rm /etc/nginx/sites-enabled/jeetcheck && systemctl reload nginx
```
The service keeps running locally, only the exposure disappears.
