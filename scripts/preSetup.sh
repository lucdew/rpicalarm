#!/bin/sh
set -e

#CFG_DIR=/etc/rpicalarm

# [ -d "${CFG_DIR}" ] || sudo mkdir ${CFG_DIR}

# sudo cp etc/rpicalarm.conf "${CFG_DIR}"/
# sudo chmod 600 "${CFG_DIR}"/rpicalarm.conf

sudo mkdir -p /var/www/rpicalarm
sudo chown pi:pi /var/www/rpicalarm

sudo mkdir -p /var/log/rpicalarm
sudo chown pi:pi /var/log/rpicalarm

sudo mkdir -p /var/run/user/1000/rpicalarm
sudo chown pi:pi /var/run/user/1000/rpicalarm

sudo mkdir -p /var/tmp/images
sudo chown pi:pi /var/tmp/images