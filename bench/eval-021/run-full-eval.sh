#!/bin/sh
# Full evaluation supervisor as run for 1.2.6 (paths made relative; see bench/eval-021/README.md).
# Fixed 12 tasks (plan/tasks.json) x arms B / C / A ($P) x executors deepseek-v4.1-flash, gpt-6.1-sol x 2 repeats.
# All arms: execution request limit 256 (excl. Jev; Jev own cap 32), existing 600 s timeout, learning frozen for A,
# same USD guard per executor. Infra-affected cases (infra-error.json, or arm-A Jev transport failures through the
# flaky proxy) are archived under $R/_infra-archive and rerun fresh, up to 3 rounds. In the recorded run DeepSeek B/C
# had been started earlier and were awaited by PID. Run from a bench root that holds evaluator/, plugins/<commit>/ (a
# copy of the plugin) and venv/; $WITH_KEYS is your own wrapper that exports JEV_API_KEY for the command it runs.
# Usage: run-full-eval.sh <commit> <dsB-pid> <dsC-pid>
set -u
P=$1 PB=$2 PC=$3
: "${DSH_BENCH_NODE:?DSH 0.2.1 node install}" "${WITH_KEYS:?wrapper exporting JEV_API_KEY}"
export DSH_BENCH_NODE DSH_BENCH_ROOT=$(pwd)
E=$(dirname "$0") H=$(dirname "$0")/plan L=256 R=results/full-$P A=results/full-$P/_infra-archive
D=deepseek-v4.1-flash G=gpt-6.1-sol
XD=deepseek-v4-flash,glm-5.3-flash,deepseek-v4-pro,glm-5.3
XG=gpt-6-sol,gpt-5.6-luna,gpt-6-luna,deepseek-v4.1-flash,glm-5.3-flash
log() { echo "$(date -Is) $*" >> logs-full-$P-supervisor.log; }
ds_run() {  # arm
  if [ "$1" = A ]; then
    $WITH_KEYS sh -c "OPENCODE_API_KEY=\$JEV_API_KEY exec python3 $H/run.py --model $D --arms A --out $R/$D/A --plugin plugins/$P --parallel 3 --repeat 2 --extra-models $XD --max-usd 0.50 --jev-model jev-1.13 --learning frozen --request-limit $L"
  else
    $WITH_KEYS sh -c "exec python3 $H/run.py --model $D --arms $1 --out $R/$D/$1 --plugin plugins/$P --parallel 3 --repeat 2 --max-usd 0.50 --request-limit $L"
  fi >> logs-full-$P-$D-$1.log 2>&1
}
ds_rounds() {  # arm: archive affected cases and resume until clean (max 3 reruns)
  for k in 1 2 3; do
    n=$(python3 $E/affected.py $R/$D/$1 --archive $A/$D/$1 2>>logs-full-$P-supervisor.log)
    log "ds $1 round $k affected=$n"
    [ "$n" = 0 ] && [ "$(find $R/$D/$1 -path '*/repeat-*' -name result.json | wc -l)" -ge 24 ] && return
    ds_run $1
  done
}
gpt_one() {  # arm lane repeat [taskfile] [suffix]
  $WITH_KEYS sh -c "exec python3 $E/host/run_one.py --model $G --arm $1 --tasks ${4:-$H/task-full-lane$2.json} --out $R/$G/$1-r$3-lane$2${5:-} --plugin plugins/$P --extra-models $XG --request-limit $L" >> logs-full-$P-$G-$1-lane$2.log 2>&1
}
gpt_lane() {  # arm lane: both repeats, then reruns of affected cases
  for r in 1 2; do
    gpt_one $1 $2 $r
    for k in 1 2 3; do
      dir=$R/$G/$1-r$r-lane$2; [ $k -gt 1 ] && dir=$R/$G/$1-r$r-lane$2-retry$((k-1))
      tf=$R/$G/.retry-$1-r$r-lane$2-$k.json
      [ -f $dir/tasks.json ] || { log "gpt $1 r$r lane$2: $dir has no tasks.json"; break; }
      n=$(python3 $E/affected.py $dir --archive $A/$G/$1-r$r-lane$2 --tasks-out $tf 2>>logs-full-$P-supervisor.log)
      log "gpt $1 r$r lane$2 round $k affected=$n"
      [ "$n" = 0 ] && break
      gpt_one $1 $2 $r $tf -retry$k
    done
  done
}
log "start v2 ($P)"
ds_rounds A &
for a in B C A; do for l in 1 2; do gpt_lane $a $l & done; done
while kill -0 $PB 2>/dev/null || kill -0 $PC 2>/dev/null; do sleep 30; done
log "ds B/C first pass done"
ds_rounds B & ds_rounds C &
wait
log "executions done"
for d in $R/$D/A $R/$D/B $R/$D/C $R/$G/*; do [ -f $d/tasks.json ] && venv/bin/python $H/grade.py $d --parallel 3 >> logs-full-$P-grade.log 2>&1; done
log "graded"
echo "$(date -Is) full eval $P graded"
