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

## Les deux fichiers nginx

`nginx-jeetcheck-limits.conf` va dans `/etc/nginx/conf.d/`, `nginx-jeetcheck.conf`
dans `/etc/nginx/sites-available/` avec un lien dans `sites-enabled/`. Les zones
doivent etre chargees avant le site, d'ou la separation.

**`/api/check` a sa propre limite, et c'est le point important.** Mesure le
27/08/2026 : un check coute 5 a 7 appels GMGN a froid, sur un quota dont le
plafond mensuel n'est pas connu. Avant cette date `/api/check` tombait dans
`location /` a 120 r/min, soit ~720 appels GMGN par minute depuis une seule IP,
pendant que la limite serree etait posee sur `/api/analyze`, que la page
n'appelle plus. Verifie apres correction : 8 requetes passent, la 9e prend un 429.

Deux zones, parce qu'une limite par IP ne protege pas d'un afflux reparti :
`jeet_check` par IP et `jeet_check_all` sur le total.

**`/api/analyze` et `/scan.html` rendent 404.** L'ancien scan de wallet complet
ouvre un budget de 150 s et peut faire des centaines d'appels par requete ; la
page ne l'appelle plus. Le code reste en place, il suffit de remplacer les deux
`return 404` par un `proxy_pass` avec `limit_req zone=jeet_analyze burst=3`.
