# 09_adb_command_payload_database

## Objective
Compile read-only PROGMEM command array manifest for all ADB shell macros

## Done When
All command strings (Launch Shizuku, Verify Identity, Get Model, Get Battery, PM enumerate/nuke/freeze/thaw, AM force-stop, etc.) stored as PROGMEM arrays. Lookup table maps macro name to flash pointer. No heap allocation for static command strings at runtime.
