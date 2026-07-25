# CS:GO GC Replacement

**CS:GO's Game Coordinator Replacement to revive matchmaking in CS:GO**

A custom Game Coordinator for CS:GO Legacy, written in Node.js.

## warning:
This code sucks and not perfect, cuz its in active developing phase

## Features

- connects to CSGO Legacy (with modified csgo_gc)
- handles messages from client
- session based client management

## Requirements

- Node.js:
npm
http
protobufjs
- CS:GO Legacy with modified `csgo_gc.dll` [from there](https://github.com/aka3257/csgo_gc-mm)

## Quick Start

drop downloaded file `Server_v2.js` in your folder with required modules,
then open console in that folder and run server with `node Server_v2.js`

## Special thanks to:

- The CSGO Modding community
- Valve for protobuf protocol

## LICENSE

GNU GPL 3.0
