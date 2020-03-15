# Introduction

This repository contains a set of tools to bridge between NMOS and SAP (or SDP
more generally).

This project is organized by Yamaha Coporation and involves DeusO GmbH, SONY and Audinate.

# Proxy

The proxy application mainly consists of a proxy class which combines both a
SAP port and a NMOS node. The proxy will listen for announcements on the SAP
port and turn them into NMOS flows, senders and devices in the NMOS node.
Likewise, if the proxy finds NMOS senders with SDP information in the NMOS
registry it will try to announce them via SAP.

The proxy class may be extended with SDP information coming from other sources.

A simple command line tool can be used to start the proxy in `bin/proxy.js`

# Other Tools

## `print_sap.js`

This tool can be used to continuously print SAP announcements.

    node bin/print_sap.js

## `print_nmos.js`

This tool can be used to print all NMOS senders observed in a network.

    node bin/print_nmos.js

# License

This software is released under the of the MIT license. See the `LICENSE` file.
