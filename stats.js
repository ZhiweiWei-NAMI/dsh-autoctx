// Per-root-session statistics for the composer chip, kept out of the record log.
export function newStats(mode,maxDecisions,pressureTokens) {
  return {mode,decisions:0,maxDecisions,delegations:0,activeChildren:0,childrenDone:0,
    compactions:0,tokensSaved:0,contextTokens:null,pressureTokens,lastDecision:null,updatedAt:0,pendingSaved:{}};
}
export function applyStatsRecord(stats,record,decisions=stats.decisions) {
  const next={...stats,decisions,contextTokens:record.nativeEstimate??stats.contextTokens};
  switch(record.kind) {
    case 'policy_snapshot': if(record.mode)next.mode=record.mode; break;
    case 'delegation_decision':
      if (record.profile) next.lastDecision=record.profile.label+'/'+(record.profile.options.reasoningEffort??'default');
      else if (record.child?.profile) next.lastDecision=record.child.profile;
      break;
    case 'child_start': next.delegations=stats.delegations+1;
      next.activeChildren=record.active??stats.activeChildren+1; break;
    case 'child_end': next.childrenDone=stats.childrenDone+1;
      next.activeChildren=record.active??Math.max(0,stats.activeChildren-1); break;
    case 'context_scores':
      next.pendingSaved={...stats.pendingSaved,[record.session]:Math.max(0,record.estimatedBefore-record.estimatedAfter)}; break;
    case 'context_kept':
    case 'context_replaced':
      if (record.kind==='context_replaced') {
        next.compactions=stats.compactions+1;
        next.tokensSaved=stats.tokensSaved+(stats.pendingSaved[record.session]??0);
      }
      next.pendingSaved={...stats.pendingSaved};delete next.pendingSaved[record.session];break;
  }
  return next;
}
