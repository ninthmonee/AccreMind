-- Synthetic schema constraint exercise, not domain service/CAS/RLS acceptance.
-- Run after 001 and 002 as the temporary PostgreSQL migration superuser.
BEGIN;
SET LOCAL search_path = akb, public;
DO $$
DECLARE
 t uuid := gen_random_uuid(); t2 uuid := gen_random_uuid(); p uuid := gen_random_uuid();
 d uuid := gen_random_uuid(); r uuid := gen_random_uuid(); sc uuid := gen_random_uuid();
 task uuid := gen_random_uuid(); c uuid := gen_random_uuid(); e uuid := gen_random_uuid(); upload uuid := gen_random_uuid();
 n uuid := gen_random_uuid(); a uuid := gen_random_uuid(); review uuid := gen_random_uuid(); k uuid := gen_random_uuid();
 session uuid := gen_random_uuid(); family2 uuid := gen_random_uuid();
BEGIN
 INSERT INTO tenants(id,name) VALUES(t,'synthetic team'),(t2,'other team');
 INSERT INTO principals(tenant_id,id,oidc_issuer,oidc_subject,display_name) VALUES(t,p,'synthetic-issuer','subject','synthetic');
 INSERT INTO domains(tenant_id,id,name) VALUES(t,d,'domain');
 INSERT INTO repos(tenant_id,id,domain_id,name,canonical_remote) VALUES(t,r,d,'repo','synthetic://repo');
 INSERT INTO scopes(tenant_id,id,kind,repo_id) VALUES(t,sc,'repo',r);
 INSERT INTO tasks(tenant_id,id,principal_id,repo_id,client_session_id,expires_at) VALUES(t,task,p,r,'test',now()+interval '8 hours');
 INSERT INTO contributions(tenant_id,id,actor_id,repo_id,task_id,idempotency_key,payload_hash,processing_status)
 VALUES(t,c,p,r,task,gen_random_uuid(),repeat('a',64),'completed');
 INSERT INTO evidence(tenant_id,id,revision,scope_id,contribution_id,source_ref,source_revision,locator,object_key,sha256,evidence_kind,status,expires_at)
 VALUES(t,e,1,sc,c,'synthetic source','commit','L1','object1',repeat('a',64),'raw','available',now()+interval '30 days'),
       (t,e,2,sc,c,'synthetic source','commit','L1','object2',repeat('b',64),'retained','available',now()+interval '90 days');
 INSERT INTO contribution_evidence VALUES(t,c,upload,e,1);
 BEGIN
  INSERT INTO contribution_evidence VALUES(t,c,upload,e,2);
  RAISE EXCEPTION 'duplicate upload mapping unexpectedly accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  INSERT INTO contribution_evidence VALUES(t,c,gen_random_uuid(),e,9);
  RAISE EXCEPTION 'unknown evidence revision unexpectedly accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 INSERT INTO candidates(tenant_id,id,contribution_id,contributor_id,scope_id,owner_id,creation_kind,body,knowledge_role)
 VALUES(t,n,c,p,sc,p,'new','{}','experience');
 INSERT INTO candidate_revisions(tenant_id,candidate_id,revision,body,actor_id,creation_kind)
 VALUES(t,n,1,'{}',p,'new');
 INSERT INTO assessments(tenant_id,id,revision,candidate_id,candidate_revision,checked_by,assessment_method,discoverability,disposition,priority,document)
 VALUES(t,a,1,n,1,p,'human_review','missing_context','knowledge_candidate','P1','{}');
 INSERT INTO reviews(tenant_id,id,candidate_id,candidate_revision,assessment_id,assessment_revision,reviewer_id,evidence_set_hash,scope_id,action,disposition,reason)
 VALUES(t,review,n,1,a,1,p,repeat('a',64),sc,'approve','knowledge_candidate','synthetic schema only');
 BEGIN
  INSERT INTO reviews(tenant_id,id,candidate_id,candidate_revision,assessment_id,assessment_revision,reviewer_id,evidence_set_hash,scope_id,action,disposition,mirror_approval,reason)
  VALUES(t,gen_random_uuid(),n,1,a,1,p,repeat('a',64),sc,'approve','knowledge_candidate',true,'bad mirror route');
  RAISE EXCEPTION 'incorrect mirror disposition unexpectedly accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 INSERT INTO knowledge_entries(tenant_id,id,scope_id,owner_id,publication_status) VALUES(t,k,sc,p,'candidate');
 INSERT INTO knowledge_revisions(tenant_id,knowledge_id,revision,candidate_id,candidate_revision,review_id,content_ref,content_hash)
 VALUES(t,k,1,n,1,review,'synthetic-content-ref',repeat('a',64));
 UPDATE knowledge_entries SET active_content_revision=1,publication_status='published' WHERE tenant_id=t AND id=k;
 INSERT INTO candidates(tenant_id,id,contribution_id,contributor_id,scope_id,owner_id,creation_kind,target_knowledge_id,base_content_revision,base_aggregate_revision,body,knowledge_role)
 VALUES(t,gen_random_uuid(),c,p,sc,p,'revision',k,1,1,'{}','experience');
 BEGIN
  INSERT INTO candidates(tenant_id,id,contribution_id,contributor_id,scope_id,owner_id,creation_kind,body,knowledge_role)
  VALUES(t,gen_random_uuid(),c,p,sc,p,'revision','{}','experience');
  RAISE EXCEPTION 'missing revision binding unexpectedly accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO candidates(tenant_id,id,contribution_id,contributor_id,scope_id,owner_id,creation_kind,target_knowledge_id,base_content_revision,base_aggregate_revision,body,knowledge_role)
  VALUES(t,gen_random_uuid(),c,p,sc,p,'revision',k,9,1,'{}','experience');
  RAISE EXCEPTION 'missing base revision unexpectedly accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 BEGIN
  INSERT INTO contribution_evidence VALUES(t2,c,gen_random_uuid(),e,1);
  RAISE EXCEPTION 'cross-tenant mapping unexpectedly accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 INSERT INTO akb_identity.sessions(id,tenant_id,principal_id,token_hash,kind,expires_at,refresh_expires_at)
 VALUES(session,t,p,repeat('a',64),'tool',now()+interval '15 minutes',now()+interval '7 days'),
       (family2,t,p,repeat('d',64),'tool',now()+interval '15 minutes',now()+interval '7 days');
 INSERT INTO akb_identity.refresh_tokens(token_hash,session_id,status,expires_at)
 VALUES(repeat('b',64),session,'active',now()+interval '7 days');
 UPDATE akb_identity.refresh_tokens SET status='consumed',consumed_at=now(),replaced_by_hash=repeat('c',64) WHERE token_hash=repeat('b',64);
 INSERT INTO akb_identity.refresh_tokens(token_hash,session_id,status,expires_at)
 VALUES(repeat('c',64),session,'active',now()+interval '7 days'),
       (repeat('e',64),family2,'active',now()+interval '7 days');
 IF NOT EXISTS(SELECT 1 FROM akb_identity.refresh_tokens WHERE token_hash=repeat('b',64) AND session_id=session AND status='consumed') THEN
  RAISE EXCEPTION 'consumed refresh history disappeared';
 END IF;
 BEGIN
  INSERT INTO akb_identity.refresh_tokens(token_hash,session_id,status,expires_at)
  VALUES(repeat('f',64),session,'active',now()+interval '7 days');
  RAISE EXCEPTION 'second active refresh unexpectedly accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 SET CONSTRAINTS ALL IMMEDIATE;
 BEGIN
  UPDATE akb_identity.refresh_tokens SET replaced_by_hash=repeat('e',64) WHERE token_hash=repeat('b',64);
  RAISE EXCEPTION 'replacement from another family unexpectedly accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
 RAISE NOTICE 'Phase A schema: upload mapping, evidence version FK, revision binding/base FK, mirror constraint, tenant FK, refresh history/unique active/same-family replacement passed';
END $$;
ROLLBACK;
