#!/usr/bin/env bash

# readlink is not portable on MAC
ROOT_DIR=$(python -c "import os; print(os.path.realpath(\"$0/../..\"));")
rsync -avzr --delete --exclude "coverage" --exclude "node_modules" --exclude "dist/" --exclude ".git"  --exclude ".gitignore" $ROOT_DIR pi:dev/
scp $ROOT_DIR/etc/antibes-rpicalarm.conf pi:dev/rpicalarm/etc/rpicalarm.conf
