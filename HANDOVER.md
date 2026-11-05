# URB Studio Booking: handover and recovery guide

This guide is for whoever looks after the booking site next. **Most problems can be fixed from the System page in a browser, at `https://<site>/system`**, using the admin passphrase. You only need server access (SSH) for the few things listed under "Needs server access".

## What looks after itself

| What | When | Where to see it |
|---|---|---|
| Database backup, verified straight after it's made | Every night at 03:00 | System → Backups |
| Old backups deleted (14 nightly, 8 weekly, 12 monthly kept) | Nightly | System → Backups |
| Database integrity check | Nightly | System → Health |
| Personal data clean-up (old emails/names, inactive members, unused images) | Nightly | System → Data & privacy |
| Schedule archived and cleared for the new year | 1 September, 04:00 | System → Yearly reset & archives |
| Health checks (domain, DNS, HTTPS, stream, disk, Node.js, …) | Every 6 hours | System → Health |
| Show of the Week: 3 Studio One shows drawn for the coming week | Every Sunday | `/show-of-the-week` |
| Show of the Week: 15 minutes recorded from the middle of each | While each show airs | `/show-of-the-week` |
| Show of the Week: recordings deleted | 2 weeks after recording | Activity log |
| Missing or damaged database replaced with the newest good backup | Every start-up | Activity log ("recovery") |
| Show images that go missing copied back from backups | Every start-up and nightly | Activity log |

If the server was switched off when one of these jobs was due, the job runs as soon as the server is back on.

Everything people do (bookings, approvals, deletions, sign-ins, settings) and everything the server does by itself is written to **System → Activity log**. Nothing can be deleted from the log. When a booking is deleted, its log entry keeps a full copy of it.

## Every month (5 minutes)

1. Open **System → Health** and fix anything red. Each check says what to do.
2. Open **System → Backups**, click **Download portable backup**, and put the file in the society's shared drive. This copy matters most. If the server dies, the backups stored on it are lost too.

## Every year

- **Before 1 September**, check the reset is switched on (System → Yearly reset). After it has run, look at the new archive and check the schedule.
- **At committee handover**, change the admin passphrase (System → Settings) and update **System → Handover** with the new contacts.
- **Domain renewal:** the Health tab warns 60 days before the domain expires. If the domain lapses, the site and the Listen Live player stop working.

## Common problems

| Problem | Fix |
|---|---|
| Bookings disappeared or look wrong | System → Backups → **Restore** last night's backup. The current state is backed up first, so you can undo the restore. |
| Somebody deleted a booking by mistake | Search the Activity log for the show's name. The delete entry's **details** hold every field, so it can be re-entered. |
| The 1 September reset cleared something it shouldn't have | System → Yearly reset → the archive → **Undo**. |
| Listen Live player is silent | Health shows whether the stream answers. If the stream has moved, change its address in System → Settings. Every site with the player picks up the change within a minute. |
| A person asks for their data, or asks to be deleted (GDPR) | System → Data & privacy → search their email → **Download** or **Erase**. You must reply within one month. |
| Nobody knows the admin passphrase | Needs server access: see below. |
| Health says "Site address & DNS: NOT this server" | The domain's DNS points at an old server. At the domain registrar, set the **A record** to this server's IP address. |
| Health says the HTTPS certificate is expiring | Needs server access: `sudo certbot renew`, then `sudo systemctl reload nginx`. |
| Health says Node.js is reaching end of life | Needs server access: see "Upgrading Node.js". |
| Health says "Auto-restart: not running under systemd" | Needs server access: install the service (see below). Otherwise the site stays down after a crash or reboot until someone restarts it by hand. |

## One-week overrides

Use these when something replaces the regular shows for one week, such as a 24-hour show. On the Schedule tab, under **Admin → One-week overrides**, click **New override**. To replace a single show, click it on the schedule and choose **Override … only**.

- The form lists which shows go off air before you save. Overrides only affect their own studio.
- Replaced shows disappear from the schedule, Listen Live and the Show of the Week draw for that week. Their weekly bookings aren't changed, so they come back by themselves.
- **Removing an override** puts the shows back straight away. Members can't book over an override.
- **For a week off with nothing replacing it**, click the weekly show on the schedule and choose **No show**. The show is then listed under One-week overrides with a **Put back** button, and the slot is free to book that week.

## Show of the Week

The team's page is `https://<site>/show-of-the-week`. To set or change its password, sign in with the admin passphrase; the setting is at the bottom of the page. Changing it signs the team out.

- **The draw** only uses Studio One, and skips the Podcast recording and Training show types (`SKIP_CATEGORIES` in `show-of-week.js`). It avoids shows shortlisted in the previous 4 weeks when there's a choice.
- **Swapping a show or using Re-draw** turns the automatic top-up off for that week, so the site won't undo a hand-made choice.
- **Recordings** are the stream's 64kbps MP3 where available (about 7MB per show), in `data/sotw-recordings/`. They aren't in backups, on purpose: they're only meant to last 2 weeks.
- **If a recording is missing**, the server was probably off during that slot, or the stream was down. The Activity log (filter: Show of the Week) gives the reason.

## Set up a free uptime monitor

The System page can't tell you the site is down, because it goes down with the site. Sign up for a free uptime monitor (e.g. UptimeRobot), point it at `https://<site>/api/health`, and have it email the committee address.

---

## Needs server access

The commands below assume an Ubuntu/Debian server with the site in `/opt/urb-booking`. Use the real paths, which are shown on **System → Handover → Where things are on the server**.

### Where everything is

```
/opt/urb-booking/            the site's code (this folder)
/opt/urb-booking/.env        admin passphrase and settings (NOT in git, NOT in backups)
/opt/urb-booking/data/       the database (urb.db) and show images (uploads/)
/opt/urb-booking/data/backups/   nightly backups (or wherever BACKUP_DIR points)
```

### Start, stop and restart the site, and read its logs

```bash
sudo systemctl restart urb-booking
sudo systemctl status urb-booking
sudo journalctl -u urb-booking -n 200
```

### Reset a forgotten admin passphrase

Edit `ADMIN_PASSPHRASE=` in `.env`, then restart the site. The new passphrase takes over and everyone is signed out.

### Install the auto-restart service (first set-up)

```bash
sudo cp deploy/urb-booking.service /etc/systemd/system/
sudo nano /etc/systemd/system/urb-booking.service   # check User= and the paths
sudo systemctl daemon-reload
sudo systemctl enable --now urb-booking
```

### Rebuild on a brand-new server

1. Install Node.js (the newest even-numbered "LTS" release), Nginx and Certbot.
2. Copy this folder to `/opt/urb-booking` (from git, or from a copy), then run `npm ci --omit=dev`.
3. `cp .env.example .env`, then set `ADMIN_PASSPHRASE` and `PUBLIC_URL`.
4. Install the service (above). Copy `deploy/nginx.conf.example` into `/etc/nginx/sites-available/` and enable it. Then run `sudo certbot --nginx -d <your-domain>`.
5. At the domain registrar, point the domain's A record at the new server's IP address.
6. Open `https://<site>/system`, sign in, go to **Backups → Restore from a file**, and upload the latest portable backup from the shared drive.

### Upgrading Node.js

The database library (better-sqlite3) is compiled for one Node.js version, so after upgrading Node.js:

```bash
cd /opt/urb-booking && npm rebuild && sudo systemctl restart urb-booking
```

### Keeping a second backup copy on another disk

Set `BACKUP_MIRROR_DIR=/path/to/other/disk/urb-backups` in `.env` and restart. Every nightly backup is then copied there too. A mounted network drive or a second volume both work.

### Moving to a new domain

1. Point the new domain at the server and run `sudo certbot --nginx -d <new-domain>`.
2. On System → Settings, change the public address. Then copy the new embed codes into any website that shows the player or the schedule.
3. Keep the old domain pointing here for a while if you can, so old embeds keep working.

## Personal data held, and for how long

| Data | Kept until (defaults, change them in System → Data & privacy) |
|---|---|
| Member name and email | 18 months with no bookings or requests, or until erased on request |
| Unapproved registrations | 60 days |
| Email on a booking | 12 months after the show's last date |
| Presenter name on a booking or archive | 5 years after the show's last date |
| Emails and IP addresses in the activity log | 12 months (the entry itself is kept) |
| Show of the Week recordings (presenters' voices) | 2 weeks after recording, or until erased on request |
| Show of the Week shortlist (show and presenter names, email) | 12 weeks |
| Backups (contain all of the above except the recordings) | At most about 13 months, then deleted automatically |

The public schedule and the Listen Live feed never send presenters' email addresses to the browser.
