#!/bin/sh
cd "$(dirname "$0")"
exec java -Xms1G -Xmx3G -jar paper.jar --nogui
