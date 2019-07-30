<!-- TOC -->

- [1. Overview](#1-overview)
- [2. Roadmap](#2-roadmap)
- [3. INSTALL on Raspberry PI](#3-install-on-raspberry-pi)
  - [3.1. Gpio](#31-gpio)
  - [3.2. Manual installation](#32-manual-installation)
    - [3.2.1. Python3](#321-python3)
    - [opencv dependencies](#opencv-dependencies)
    - [3.2.2. ffmpeg for webcam streaming to youtube](#322-ffmpeg-for-webcam-streaming-to-youtube)
    - [3.2.3. rpicalarm](#323-rpicalarm)
- [4. rd parties setup](#4-rd-parties-setup)
  - [4.1. Cloud Backup of photos](#41-cloud-backup-of-photos)
    - [4.1.1. Cloudinary](#411-cloudinary)
  - [4.2. Alarm control](#42-alarm-control)
    - [4.2.1. Telegram](#421-telegram)
  - [4.3. Authentication](#43-authentication)
    - [4.3.1. Twilio](#431-twilio)
  - [4.4. alert](#44-alert)
    - [4.4.1. email](#441-email)

<!-- /TOC -->

# 1. Overview

rpicalarm stands for Raspberry pi camera alarm

It is an alarm systems running on NodeJs and python3 that relies on a PIR sensor to detect motion and warn someone over social media or other means.
Currently the alarm system workflow is the following:

- Movement is detected
- rpicalarm starts taking pictures every few seconds and backup them in the cloud
- rpicalarm tries to authenticate the user by pinging him with telegram messaging or calling him through a twilio voice server for examples
  - If the user successfully authenticates with his pin, alarm is disarmed for a given duration, camera stops taking picture and photos are deleted
  - It the user authentication fails, camera continues taking picture and backup them, an alert email is sent to the end-user

A Telegram bot is also used as a command center to set, disarm or disable the alarm. You can also have the telegram bot send you pictures.

A demo is worth a lengthy explanation so here's a link to a youtube video demonstration <https://youtu.be/IQVJehvTrwI>:

![rpicalarm](https://img.youtube.com/vi/IQVJehvTrwI/0.jpg)

Currently this project is just a demo for fun of what can be achieved with Raspberry pi and the raspberry pi camera module
If you are interested please find below some light explanations of the setup process.

**This project has been greatly inspired by the [Raspberry Pi Security System](https://github.com/FutureSharks/rpi-security)**. Thanks to the authors.
Mine is not a fork but most of the ideas come from there.

**Update 03/2019**: the application has been rewritten fully in Python3 for different reasons mostly for the libraries that are used
that are more mature in Python (Raspberry pi camera module, telegram bot, opencv...)

**Update 03/2018**: the application has been rewritten in typescript. Some unit/integration tests have been developped.
Python3 is being used for the excellent picamera module and also for upcoming machine learning detection.

# 2. Roadmap

In any particular order and no timeframe :wink:

- Use the camera movement detection (ripoff of the [Raspberry Pi Security System](https://github.com/FutureSharks/rpi-security))
- Backup in AWS S3 in addition to cloudinary
- AI local face detection but my [initial tests](https://github.com/lucdew/ml-experiments) show that it will probably not fit on the Pi.
  I will probably endup using AWS rekognition.

# 3. INSTALL on Raspberry PI

The install process make the following assumptions:

- [Rasbpian](https://www.raspbian.org/) jessie or higher is installed
- The Pir sensor is connected to gpio 14
- The Raspberry pi is connected to the internet through a non-static ip (will be configurable in future release)

## 3.1. Gpio

To have the pi user be granted the permission to open the gpio 14 port, do the following:

- Open the file /etc/udev/rules.d/99-com.rules and check that the following rules is present (it was already the case on raspbian 8.0):

`SUBSYSTEM=="gpio*", PROGRAM="/bin/sh -c 'chown -R root:gpio /sys/class/gpio && chmod -R 770 /sys/class/gpio; chown -R root:gpio /sys/devices/virtual/gpio && chmod -R 770 /sys/devices/virtual/gpio'"`

- Then enter the following command

```
sudo usermod -a -G gpio pi
gpio export 14 out
echo 1 > /sys/class/gpio/gpio14/value
```

## 3.2. Manual installation

### 3.2.1. Python3

Install python3,pip3 and update it:

```
sudo apt install python3
sudo apt install python3-pip
sudo pip3 install --upgrade pip
```

### opencv dependencies

At the time of the writing of this document, I had to install the following dependencies for opencv to work properly

```
sudo apt install libatlas3-base libsz2 libharfbuzz0b libtiff5 libjasper1 libilmbase12 libopenexr22 libilmbase12 libgstreamer1.0-0 libavcodec57 libavformat57 libavutil55 libswscale4 libqtgui4 libqt4-test libqtcore4
```

### 3.2.2. ffmpeg for webcam streaming to youtube

ffmpeg is used to encode video stream to rtmp protocol and stream via youtube live stream
Sadly ffmpeg needs to be compiled. I had no luck with avconv and it seemed that with it the video stream bandwidth was not sufficient
even reducing the bitrate

Follow the instructions from http://www.jeffreythompson.org/blog/2014/11/13/installing-ffmpeg-for-raspberry-pi/
I copied it here in the case the web page disappears

First install h264 video codec

```
git clone git://git.videolan.org/x264
cd x264
./configure --host=arm-unknown-linux-gnueabi --enable-static --disable-opencl
make
sudo make install
```

Then ffmpeg

```
git clone https://github.com/FFmpeg/FFmpeg.git
cd ffmpeg
sudo ./configure --arch=armel --target-os=linux --enable-gpl --enable-libx264 --enable-nonfree
make
sudo make install
```

For reference to install avconv use

```
sudo apt-get install libav-tools
```

### 3.2.3. rpicalarm

Perform a git clone of the repository

```
git clone https://github.com/lucdew/rpicalarm.git
```

Copy configuration template to a custom configuration file

```
cp etc/rpicalarm-example.conf etc/rpicalarm.conf
```

Create all 3rd parties account below (can take a few hours) and update the etc/rpicalarm.conf accordingly

Then execute

```
sudo make
```

Enable the rpicalarm service

```
sudo systemctl enable rpicalarm
```

Start the service

```
sudo systemctl start rpicalarm
```

# 4. rd parties setup

## 4.1. Cloud Backup of photos

### 4.1.1. Cloudinary

Just create an [Cloudinary](http://cloudinary.com/) account
You need to retrieve 3 assets:

- Api key
- Api secret
- Cloud name

## 4.2. Alarm control

TODO

### 4.2.1. Telegram

TODO

## 4.3. Authentication

### 4.3.1. Twilio

TODO

## 4.4. alert

### 4.4.1. email

Setting up a smtp server is beyond the current install procedure.
I use zoho mail with a custom domain. It is free. You can define an application account and use their smtp server to send emails.
(I also had to setup spf,dkim,etc)
There are other providers like sendgrid,etc.
