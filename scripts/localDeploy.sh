#!/bin/sh

npm pack
rm -rf /var/www/rpicalarm/*
tar zxvf rpicalarm*.tgz -C /var/www/rpicalarm --strip=1
cd /var/www/rpicalarm
npm install
npm build-ts
