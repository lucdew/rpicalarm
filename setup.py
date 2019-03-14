#!/usr/bin/env python3
import os
from setuptools import setup


def get_requirements():
    """Build the requirements list for this project"""
    requirements_list = []

    with open('requirements.txt') as requirements:
        for install in requirements:
            requirements_list.append(install.strip())

    return requirements_list


for s_dir in ["/var/lib/rpicalarm", "/var/log/rpicalarm"]:
    os.makedirs(s_dir, 0o755, exist_ok=True)
    os.chown(s_dir, 1000, 1000)

setup(
    name='rpicalarm',
    version='0.1',
    author='Luc Dewavrin',
    author_email='luc.dewavrin+github@gmail.com',
    url='https://github.com/lucdew/rpicalarm-python',
    license='MIT',
    description='Alaram system for Raspberry PI written in Python relying on a PIR sensor and camera',
    long_description=open('README.md', encoding='utf-8').read(),
    packages=[
        'rpicalarm',
        'rpicalarm/agents'
    ],
    scripts=['rpicalarm-cli.py'],
    data_files=[
        ('/lib/systemd/system', ['etc/rpicalarm.service']),
        ('/etc', ['etc/rpicalarm.conf'])
        #('/var/lib/rpicalarm', ['etc/data.yaml'])
    ],
    install_requires=get_requirements(),
    classifiers=[
        'Environment :: Console',
        'Topic :: Security',
        'Operating System :: POSIX',
        'Programming Language :: Python :: 3 :: Only'
    ],
)
