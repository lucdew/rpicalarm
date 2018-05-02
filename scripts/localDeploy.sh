#!/bin/bash
set -e

BASE_DIR=$(python3 -c "import os; print(os.path.realpath(\"$0/../..\"));")
echo $BASE_DIR
cd $BASE_DIR
sudo pip3 install -r requirements.txt
npm install
npm run build
rsync -av --delete --filter='P node_modules' --exclude "__pycache__" dist/ /var/www/rpicalarm/
cd /var/www/rpicalarm
npm install --only=prod