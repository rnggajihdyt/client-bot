L=$HOME/.pm2/logs/bot-client-out-4.log
awk '/\(1836605\)/ {p=1} p' "$L" > /tmp/w6.txt
echo '=== konteks tiap 401 ==='
grep -n 'negative publish ack' /tmp/w6.txt | cut -d: -f1 | while read n; do echo "--- sekitar baris $n"; sed -n "$((n-14)),$((n+8))p" /tmp/w6.txt; done
