#!/usr/bin/env bash

SRC_DIR=$(python -c "import os; print(os.path.realpath(\"$0/../..\"));")
cd $SRC_DIR
echo $SRC_DIR
python -m grpc_tools.protoc -I. --python_out=. --grpc_python_out=. backendserver/backend.proto
