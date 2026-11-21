OG SOS Revival - SOS: Classic community client mod
==================================================

What it is
----------
A small drop-in mod for SOS: Classic (Steam). It lets the game find the community
relaunch servers, adds an in-game server list, and a few quality-of-life options.
It connects to the community servers at sos.joltora.com (OG SOS Revival). Nothing is
sent anywhere else.

You must own SOS: Classic on Steam. This mod does not include or replace any game
files and does not work without the game.

What it does
------------
- Points the game at the community backend (sos.joltora.com:7781), so you can log in
  and play without editing any game config.
- SERVERS button on the main menu (top centre): a live list of community servers.
  Click a server to join it. Press REFRESH to update the list, VOTE to vote to
  start a match in a lobby, and REPORT to report a player (pick the player, a
  reason, and optionally paste a link to a clip; the report goes to the community
  moderators).
- A relaunch announcement replaces the old "servers will shut down" notice at start.
- Replaces the "SOSTEST" build label with "OG SOS Revival".
- Unlocks the unreleased Ronin outfit parts and one beard in the character screen
  (UnlockUnreleasedCosmetics in the ini).
- Optional settings in sos_client.ini: borderless window, console variables
  (frame cap, screen percentage and so on), the announcement text and colours, and more.
- Keeps itself up to date: once per start it checks sos.joltora.com for a new,
  digitally signed version of the mod and installs it the next time you start the
  game. Updates that are not signed by the author, or older than what you have, are
  refused, and the previous version is kept in case something goes wrong.
  Set AutoUpdate=0 in sos_client.ini to turn this off.

Install
-------
1. Find your game folder: in Steam, right-click SOS: Classic, Manage, Browse local
   files. Open SOS\Binaries\Win64 (the folder with SOS-Win64-Shipping.exe).
2. Copy all five files from this archive into that folder:
     xinput1_3.dll
     sos_client_core.dll
     sos_client_core.manifest
     sos_client_core.sig
     sos_client.ini
3. Start the game from Steam as usual. On the main menu, press START, then use SERVERS.

Uninstall
---------
Delete xinput1_3.dll and every file starting with sos_client from that folder.
(If Steam "verifies" the game files it will not touch them, they are extra files.)

Settings
--------
Open sos_client.ini in a text editor. Every key has a comment. Changes apply the next
time you start the game. The mod writes a log to sos_client.log in the same folder;
include it if you report a problem.

Notes
-----
- The mod is a replacement xinput1_3.dll that the game loads from its own folder (a
  common technique; the file forwards controller input to Windows). Some antivirus
  tools warn about unknown DLLs; the files are plain and the source is public.
- It only runs inside SOS: Classic and does nothing to any other program.
- Steam DLC items are NOT unlocked by default (UnlockDlcCosmetics=0). That option is
  for testing only; do not turn it on unless you own the items.
- Not affiliated with the original developers or publisher of SOS.

Credits
-------
Scwunge and the OG SOS Revival team.
