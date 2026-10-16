-- Run after 202610150001_luna_erp_core.sql and 20261016135000_luna_multi_agent_platform.sql
-- Intended for a disposable PostgreSQL database only. Does not touch production.
DO $luna_test$
DECLARE
  v_count integer;
  v_status text;
  v_requires_gate boolean;
  v_parent uuid;
  v_child uuid;
  v_approval uuid;
  v_claimed uuid;
  v_first uuid;
  v_second uuid;
  v_live_order uuid;
  v_live_approval uuid;
  v_live_blocked boolean := false;
  v_result jsonb;
BEGIN
  SELECT count(*)::integer INTO v_count FROM public.luna_erp_agents;
  IF v_count <> 16 THEN
    RAISE EXCEPTION 'EXPECTED_16_AGENT_ROLES_GOT_%', v_count;
  END IF;
  IF EXISTS (SELECT 1 FROM public.luna_erp_agents WHERE health_status <> 'NOT_CONNECTED') THEN
    RAISE EXCEPTION 'SEEDED_AGENTS_MUST_START_NOT_CONNECTED';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.luna_erp_agent_runs'::regclass) THEN
    RAISE EXCEPTION 'AGENT_RUNS_RLS_NOT_ENABLED';
  END IF;
  IF has_table_privilege('anon', 'public.luna_erp_agent_runs', 'SELECT') THEN
    RAISE EXCEPTION 'ANON_CAN_READ_AGENT_RUNS';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.luna_erp_agent_runs', 'SELECT') THEN
    RAISE EXCEPTION 'SERVICE_ROLE_CANNOT_READ_AGENT_RUNS';
  END IF;
  IF has_function_privilege('anon', 'public.luna_erp_claim_next_work_order(text,uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ANON_CAN_CLAIM_WORK_ORDERS';
  END IF;

  -- Parent-level approval queues safe child work and creates an audit event.
  INSERT INTO public.luna_erp_work_orders
    (idempotency_key,title,description,work_type,status,priority,owner_agent_key,acceptance_criteria,
     evidence,risk_level,paper_only,requires_human_gate,task_payload,trace_id)
  VALUES
    ('test-parent-approval-1','Gate parent','Test parent gate','CEO_PARENT','BLOCKED',3,'ceo_orchestrator',
     '["Review outcome"]'::jsonb,'[]'::jsonb,'MEDIUM',true,true,
     '{"approval_gate":"PRODUCTION_PUBLISH"}'::jsonb,gen_random_uuid())
  RETURNING id INTO v_parent;

  INSERT INTO public.luna_erp_work_orders
    (idempotency_key,title,description,work_type,status,priority,owner_agent_key,acceptance_criteria,
     evidence,risk_level,paper_only,requires_human_gate,parent_work_order_id,task_payload,trace_id,blocker_code)
  VALUES
    ('test-child-approval-1','Gate child','Test inherited gate','AGENT_TASK','BLOCKED',3,'product_manager',
     '["Draft is complete"]'::jsonb,'[]'::jsonb,'LOW',true,true,v_parent,
     '{"approval_gate":"NONE"}'::jsonb,gen_random_uuid(),'HUMAN_APPROVAL_REQUIRED')
  RETURNING id INTO v_child;

  INSERT INTO public.luna_erp_approvals(work_order_id,gate_type,status,requested_by)
  VALUES (v_parent,'PRODUCTION_PUBLISH','PENDING','ceo_orchestrator') RETURNING id INTO v_approval;

  SELECT public.luna_erp_apply_human_approval(v_approval,'APPROVED','ci-admin','Disposable test approval')
  INTO v_result;
  IF v_result->>'decision' <> 'APPROVED' THEN RAISE EXCEPTION 'PARENT_APPROVAL_NOT_RECORDED'; END IF;
  SELECT status, requires_human_gate INTO v_status, v_requires_gate
  FROM public.luna_erp_work_orders WHERE id=v_child;
  IF v_status <> 'QUEUED' OR v_requires_gate THEN
    RAISE EXCEPTION 'APPROVED_PARENT_GATE_DID_NOT_QUEUE_CHILD: status=% gated=%',v_status,v_requires_gate;
  END IF;
  SELECT count(*)::integer INTO v_count FROM public.luna_erp_audit_events
  WHERE work_order_id=v_parent AND event_type='HUMAN_APPROVAL_DECIDED' AND next_status='APPROVED';
  IF v_count <> 1 THEN RAISE EXCEPTION 'PARENT_APPROVAL_AUDIT_MISSING'; END IF;

  -- A child-specific approval cannot bypass a pending parent-level gate.
  INSERT INTO public.luna_erp_work_orders
    (idempotency_key,title,description,work_type,status,priority,owner_agent_key,acceptance_criteria,
     evidence,risk_level,paper_only,requires_human_gate,task_payload,trace_id)
  VALUES
    ('test-parent-nested-gate','Nested gate parent','Test nested gates','CEO_PARENT','BLOCKED',3,'ceo_orchestrator',
     '["Review outcome"]'::jsonb,'[]'::jsonb,'HIGH',true,true,
     '{"approval_gate":"PRODUCTION_PUBLISH"}'::jsonb,gen_random_uuid())
  RETURNING id INTO v_parent;

  INSERT INTO public.luna_erp_work_orders
    (idempotency_key,title,description,work_type,status,priority,owner_agent_key,acceptance_criteria,
     evidence,risk_level,paper_only,requires_human_gate,parent_work_order_id,task_payload,trace_id,blocker_code)
  VALUES
    ('test-child-nested-gate','Nested gate child','Test own gate','AGENT_TASK','BLOCKED',3,'product_manager',
     '["Draft is complete"]'::jsonb,'[]'::jsonb,'HIGH',true,true,v_parent,
     '{"approval_gate":"POLICY_CHANGE"}'::jsonb,gen_random_uuid(),'HUMAN_APPROVAL_REQUIRED')
  RETURNING id INTO v_child;

  INSERT INTO public.luna_erp_approvals(work_order_id,gate_type,status,requested_by)
  VALUES (v_parent,'PRODUCTION_PUBLISH','PENDING','ceo_orchestrator');
  INSERT INTO public.luna_erp_approvals(work_order_id,gate_type,status,requested_by)
  VALUES (v_child,'POLICY_CHANGE','PENDING','ceo_orchestrator') RETURNING id INTO v_approval;

  PERFORM public.luna_erp_apply_human_approval(v_approval,'APPROVED','ci-admin','Approve child gate first');
  SELECT status, requires_human_gate INTO v_status, v_requires_gate
  FROM public.luna_erp_work_orders WHERE id=v_child;
  IF v_status <> 'BLOCKED' OR NOT v_requires_gate THEN
    RAISE EXCEPTION 'CHILD_APPROVAL_BYPASSED_PARENT_GATE';
  END IF;

  SELECT id INTO v_approval FROM public.luna_erp_approvals
  WHERE work_order_id=v_parent AND gate_type='PRODUCTION_PUBLISH';
  PERFORM public.luna_erp_apply_human_approval(v_approval,'APPROVED','ci-admin','Approve parent gate');
  SELECT status, requires_human_gate INTO v_status, v_requires_gate
  FROM public.luna_erp_work_orders WHERE id=v_child;
  IF v_status <> 'QUEUED' OR v_requires_gate THEN
    RAISE EXCEPTION 'NESTED_APPROVALS_DID_NOT_QUEUE_CHILD: status=% gated=%',v_status,v_requires_gate;
  END IF;

  -- A privileged user still cannot approve LIVE_TRADING.
  INSERT INTO public.luna_erp_work_orders
    (idempotency_key,title,description,work_type,status,priority,owner_agent_key,acceptance_criteria,
     evidence,risk_level,paper_only,requires_human_gate,task_payload,trace_id)
  VALUES
    ('test-live-trading-forbidden','Live trading gate','Must remain blocked','CEO_PARENT','BLOCKED',5,'ceo_orchestrator',
     '["Should never execute"]'::jsonb,'[]'::jsonb,'CRITICAL',true,true,
     '{"approval_gate":"LIVE_TRADING"}'::jsonb,gen_random_uuid())
  RETURNING id INTO v_live_order;
  INSERT INTO public.luna_erp_approvals(work_order_id,gate_type,status,requested_by)
  VALUES (v_live_order,'LIVE_TRADING','PENDING','ceo_orchestrator') RETURNING id INTO v_live_approval;

  BEGIN
    PERFORM public.luna_erp_apply_human_approval(v_live_approval,'APPROVED','ci-admin','This must fail');
  EXCEPTION WHEN insufficient_privilege THEN
    v_live_blocked := true;
  END;
  IF NOT v_live_blocked THEN RAISE EXCEPTION 'LIVE_TRADING_APPROVAL_WAS_NOT_BLOCKED'; END IF;
  SELECT status INTO v_status FROM public.luna_erp_approvals WHERE id=v_live_approval;
  IF v_status <> 'PENDING' THEN RAISE EXCEPTION 'FORBIDDEN_LIVE_APPROVAL_CHANGED_STATUS'; END IF;

  -- Queue claims are atomic and dependency-aware: an uncompleted predecessor blocks its child.
  UPDATE public.luna_erp_agents SET health_status='HEALTHY' WHERE agent_key='product_manager';
  INSERT INTO public.luna_erp_work_orders
    (idempotency_key,title,description,work_type,status,priority,owner_agent_key,acceptance_criteria,
     evidence,risk_level,paper_only,requires_human_gate,task_payload,trace_id)
  VALUES
    ('test-queue-parent','Queue parent','Parent for claim test','CEO_PARENT','RUNNING',3,'ceo_orchestrator',
     '["Tasks reviewed"]'::jsonb,'[]'::jsonb,'LOW',true,false,'{"approval_gate":"NONE"}'::jsonb,gen_random_uuid())
  RETURNING id INTO v_parent;

  INSERT INTO public.luna_erp_work_orders
    (idempotency_key,title,description,work_type,status,priority,owner_agent_key,acceptance_criteria,
     evidence,risk_level,paper_only,requires_human_gate,parent_work_order_id,task_payload,trace_id)
  VALUES
    ('test-queue-first','First dependency','Claim before dependent','AGENT_TASK','QUEUED',4,'product_manager',
     '["Produced output"]'::jsonb,'[]'::jsonb,'LOW',true,false,v_parent,
     '{"approval_gate":"NONE"}'::jsonb,gen_random_uuid())
  RETURNING id INTO v_first;

  INSERT INTO public.luna_erp_work_orders
    (idempotency_key,title,description,work_type,status,priority,owner_agent_key,dependency_ids,acceptance_criteria,
     evidence,risk_level,paper_only,requires_human_gate,parent_work_order_id,task_payload,trace_id)
  VALUES
    ('test-queue-second','Second dependency','Wait for first','AGENT_TASK','QUEUED',4,'product_manager',ARRAY[v_first],
     '["Produced output"]'::jsonb,'[]'::jsonb,'LOW',true,false,v_parent,
     '{"approval_gate":"NONE"}'::jsonb,gen_random_uuid())
  RETURNING id INTO v_second;

  SELECT id INTO v_claimed FROM public.luna_erp_claim_next_work_order('product_manager',v_parent,120);
  IF v_claimed IS DISTINCT FROM v_first THEN
    RAISE EXCEPTION 'QUEUE_DID_NOT_CLAIM_ONLY_READY_PREDECESSOR: claimed=% expected=%',v_claimed,v_first;
  END IF;
  SELECT id INTO v_claimed FROM public.luna_erp_claim_next_work_order('product_manager',v_parent,120);
  IF v_claimed IS NOT NULL THEN RAISE EXCEPTION 'DEPENDENT_CLAIMED_BEFORE_PREDECESSOR_COMPLETED'; END IF;
  UPDATE public.luna_erp_work_orders SET status='COMPLETED', updated_at=now() WHERE id=v_first;
  SELECT id INTO v_claimed FROM public.luna_erp_claim_next_work_order('product_manager',v_parent,120);
  IF v_claimed IS DISTINCT FROM v_second THEN
    RAISE EXCEPTION 'DEPENDENT_NOT_CLAIMED_AFTER_PREDECESSOR_COMPLETED: claimed=% expected=%',v_claimed,v_second;
  END IF;

  RAISE NOTICE 'LUNA multi-agent migration smoke test passed: 16 roles, least privilege, approval audit, parent gate, LIVE_TRADING denial, dependency-aware claims.';
END
$luna_test$;
