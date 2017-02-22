# Overview

rpicalarm stands for Raspberry pi camera alarm

It is an alarm systems running on NodeJs that relies on a PIR sensor to detect motion and warn someone over social media or other means.
Currently the alarm system workflow is the following:
* Movement is detected
* rpicalarm starts taking pictures every few seconds and backup them in the cloud
* rpicalarm tries to authenticate the user by pinging him with telegram messaging or calling him through a twilio voice server
  * If the user succesfully authenticates with his pin, alarm is disarmed for a given duration, camera stops taking picture and photos are deleted
  * It the user authentication fails, camera continues taking picture and backup them, an alert email is sent to the end-user

A Telegram bot is also used as a command center to set, disarm or disable the alarm. You can also have the telegram bot send you pictures.

A demo is worth a lengthy explanation so here's a link to a youtube video demonstration: <https://youtu.be/IQVJehvTrwI>

Currently this project is just a demo for fun of what can be achieved with Raspberry pi and the raspberry pi camera module
If you are interested please find below some very partial explanations of the setup process...


# INSTALL on Raspberry PI

The install process make the following assumptions:
* [Rasbpian](https://www.raspbian.org/) jessie or higher is installed
* NodeJs server will run as pi user
* The Pir sensor is connected to gpio 14
* The Raspberry pi is connected to the internet through a non-static ip (will be configurable in future release)


## Gpio

To have the pi user be granted the permission to open the gpio 14 port, do the following:

* Open the file /etc/udev/rules.d/99-com.rules and check that the following rules is present (it was already the case on raspbian 8.0):

`SUBSYSTEM=="gpio*", PROGRAM="/bin/sh -c 'chown -R root:gpio /sys/class/gpio && chmod -R 770 /sys/class/gpio; chown -R root:gpio /sys/devices/virtual/gpio && chmod -R 770 /sys/devices/virtual/gpio'"`

* Then enter the following command
```
sudo usermod -a -G gpio pi
gpio export 14 out
echo 1 > /sys/class/gpio/gpio14/value
```

## NodeJs

Create /usr/local/etc/npmrc and set :
user=pi

Install pm2 as pi user:
```
npm install pm2 -g
pm2 install pm2-logrotate
```

## rpicalarm

Perform a git clone of the repository
```
git clone https://github.com/lucdew/rpicalarm.git
```
Create all 3rd parties account below (can take a few hours) and update the etc/rpicalarm.conf accordingly


When done execute the shell script:
```
sh scripts/localDeploy.sh
```

Then start the server:
```
pm2 start etc/ecosystem.config.js
```

Configure pm2 to automatically start the rpicalarm when the server starts:
```
pm2 save
```


# 3rd parties setup

## Cloud Backup of photos

### Cloudinary

Just create an [Cloudinary](http://cloudinary.com/) account
You need to retrieve 3 assets:
* Api key
* Api secret
* Cloud name


## Alarm control

TODO

### Telegram

TODO

## Authentication

### Twilio
TODO

## alert

### email
Setting up a smtp server is beyond the current install procedure.
I use zoho mail with a custom domain. It is free. You can define an application account and use their smtp server to send emails.
(I also had to setup spf,dkim,etc)
There are other providers like sendgrid,etc.