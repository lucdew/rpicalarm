#!/bin/sh
set -e

sudo mkdir -p /var/log/rpicalarm
sudo chown pi:pi /var/log/rpicalarm

sudo mkdir -p /var/run/user/1000/rpicalarm
sudo chown pi:pi /var/run/user/1000/rpicalarm

sudo mkdir -p /var/tmp/images
sudo chown pi:pi /var/tmp/images