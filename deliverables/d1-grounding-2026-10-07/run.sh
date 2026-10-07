#!/bin/bash
set -u
D=<session-scratchpad>/d1
PORT=58771
mkdir -p $D/out
$D/src/build/bin/llama-server -m $D/models/d1-3B-Q8_0.gguf --mmproj $D/models/mmproj-d1-3B-F16.gguf --host 127.0.0.1 --port $PORT -c 8192 --parallel 1 > $D/out/server.log 2>&1 &
SRV=$!
for i in $(seq 1 120); do curl -s -m 1 http://127.0.0.1:$PORT/health | grep -q '"ok"' && break; sleep 1; done
echo "server up after ${i}s"
T0=$(date +%s)
uv run --quiet --python 3.12 --with pillow python $D/d1_blender_test.py $D/blender-default.png $D/out $PORT
echo "test took $(( $(date +%s) - T0 ))s"
kill -TERM $SRV; wait $SRV 2>/dev/null
