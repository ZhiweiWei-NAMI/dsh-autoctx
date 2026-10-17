// Per-root-session statistics for the composer chip, kept out of the record log.
export function newStats(mode,maxDecisions,pressureTokens) {
  return {mode,decisions:0,maxDecisions,delegations:0,activeChildren:0,childrenDone:0,
    compactions:0,tokensSaved:0,contextTokens:null,pressureTokens,lastDecision:null,
    reviews:0,reviewsLgtm:0,advisors:0,jevUnavailable:null,syncNotes:0,ledgerNotes:0,modelChoices:0,
    // USD by category (unpriced counts calls without a catalog price) and provider-reported cache by role.
    cost:{executor:0,children:0,jev:0,compaction:0},unpriced:0,
    cache:{},historySeeded:0,forks:0,deferrals:0,
    plan:null,choices:{},learning:null,
    updatedAt:0,pendingSaved:{}};
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
    case 'review_end': next.reviews=stats.reviews+1;
      if (record.lgtm) next.reviewsLgtm=stats.reviewsLgtm+1; break;
    case 'advisor_end': next.advisors=stats.advisors+1; break;
    case 'jev_unavailable': next.jevUnavailable=record.httpStatus??'network'; break;
    case 'sync_note': next.syncNotes=stats.syncNotes+1; break;
    case 'ledger_note': next.ledgerNotes=stats.ledgerNotes+1; break;
    case 'model_choice': next.modelChoices=stats.modelChoices+1;
      next.choices={...stats.choices,[record.role]:{model:record.model??null,via:record.via,tag:record.tag,
        confidence:record.confidence??null,candidates:record.candidates??[],filtered:record.filtered??[]}};
      break;
    case 'execution_call': {
      const cost={...stats.cost};
      if (record.category && Number.isFinite(record.usd)) cost[record.category]=(cost[record.category]??0)+record.usd;
      next.cost=cost;
      if (record.category && !Number.isFinite(record.usd)) next.unpriced=stats.unpriced+1;
      if (record.role && record.usage) {
        const key=record.role==='executor'?'executor':record.role+' '+record.model, prior=stats.cache[key]??{calls:0,input:0,cacheRead:0};
        const u=record.usage;
        next.cache={...stats.cache,[key]:{calls:prior.calls+1,
          input:prior.input+(u.inputTokens??0)+(u.cacheReadTokens??0)+(u.cacheWriteTokens??0),
          cacheRead:prior.cacheRead+(u.cacheReadTokens??0)}};
      }
      break;
    }
    case 'jev': if (Number.isFinite(record.usd)) next.cost={...stats.cost,jev:stats.cost.jev+record.usd};
      else next.unpriced=stats.unpriced+1; break;
    case 'review_start': if (record.provider==='fork') { next.forks=stats.forks+1; if (record.historySeeded) next.historySeeded=stats.historySeeded+1; } break;
    case 'turn_plan': next.plan={tag:record.tag,effort:record.effort,via:record.via,highReasoning:record.highReasoning??null}; break;
    case 'effort_checkpoint': next.plan={...(stats.plan??{}),effort:record.to,via:'checkpoint',highReasoning:record.highReasoning}; break;
    case 'context_deferred': next.deferrals=stats.deferrals+1; break;
    case 'learning': next.learning={mode:record.mode,version:record.version??null,proposed:record.proposed,
      applied:record.applied??[],pending:record.pending??null,reason:record.reason??null}; break;
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
