CREATE SCHEMA IF NOT EXISTS __SCHEMA__;
REVOKE ALL ON SCHEMA __SCHEMA__ FROM PUBLIC;
GRANT USAGE ON SCHEMA __SCHEMA__ TO tally_app;

CREATE TABLE __SCHEMA__.accounts(
 id text PRIMARY KEY CHECK(id ~ '^[A-Za-z0-9_-]{1,80}$'),
 currency text NOT NULL CHECK(currency IN ('USD','EUR','JPY')),
 allow_negative boolean NOT NULL DEFAULT false,
 balance numeric(30,0) NOT NULL DEFAULT 0,
 UNIQUE(id,currency), CHECK(allow_negative OR balance>=0));
CREATE TABLE __SCHEMA__.ledger_events(
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id uuid NOT NULL UNIQUE,
 request_key text NOT NULL UNIQUE,
 currency text NOT NULL,
 request_text text NOT NULL,
 request_digest text NOT NULL CHECK(length(request_digest)=64),
 event_text text NOT NULL,
 previous_hash text NOT NULL CHECK(length(previous_hash)=64),
 hash text NOT NULL CHECK(length(hash)=64),
 created_txid bigint NOT NULL DEFAULT txid_current(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(event_id,currency));
CREATE TABLE __SCHEMA__.ledger_lines(
 event_id uuid NOT NULL,account_id text NOT NULL,currency text NOT NULL,
 amount numeric(30,0) NOT NULL CHECK(amount<>0 AND abs(amount)<1000000000000000000),
 PRIMARY KEY(event_id,account_id),
 FOREIGN KEY(event_id,currency) REFERENCES __SCHEMA__.ledger_events(event_id,currency),
 FOREIGN KEY(account_id,currency) REFERENCES __SCHEMA__.accounts(id,currency));
CREATE TABLE __SCHEMA__.rules(version text PRIMARY KEY,snapshot_text text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE __SCHEMA__.decisions(request_id text PRIMARY KEY,input_text text NOT NULL,version text NOT NULL REFERENCES __SCHEMA__.rules(version),result_text text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE __SCHEMA__.catalogs(version text PRIMARY KEY,snapshot_text text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE __SCHEMA__.recon_batches(id text PRIMARY KEY,input_digest text NOT NULL,bank jsonb NOT NULL,ledger jsonb NOT NULL,summary jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE __SCHEMA__.recon_matches(batch_id text REFERENCES __SCHEMA__.recon_batches(id),bank_id text NOT NULL,ledger_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('automatic','reviewed')),explanation jsonb NOT NULL,PRIMARY KEY(batch_id,bank_id),UNIQUE(batch_id,ledger_id));
CREATE TABLE __SCHEMA__.recon_exceptions(batch_id text REFERENCES __SCHEMA__.recon_batches(id),bank_id text NOT NULL,reason text NOT NULL,status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),version integer NOT NULL DEFAULT 0,PRIMARY KEY(batch_id,bank_id));
CREATE TABLE __SCHEMA__.resolutions(id text PRIMARY KEY,batch_id text NOT NULL,bank_id text NOT NULL,ledger_id text NOT NULL,reason text NOT NULL,input_digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE __SCHEMA__.feeds(id text PRIMARY KEY,budget_ms integer NOT NULL CHECK(budget_ms BETWEEN 1000 AND 86400000),expected_ids jsonb NOT NULL);
CREATE TABLE __SCHEMA__.points(feed_id text REFERENCES __SCHEMA__.feeds(id),id text NOT NULL,source_at timestamptz NOT NULL,value numeric(30,0) NOT NULL CHECK(value>0),PRIMARY KEY(feed_id,id));
CREATE TABLE __SCHEMA__.audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,kind text NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE __SCHEMA__.sessions(hash text PRIMARY KEY,csrf text NOT NULL,expires timestamptz NOT NULL);

CREATE FUNCTION __SCHEMA__.immutable_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable_fact'; END $$;
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON __SCHEMA__.ledger_events FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.immutable_fact();
CREATE TRIGGER immutable_lines BEFORE UPDATE OR DELETE ON __SCHEMA__.ledger_lines FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.immutable_fact();
CREATE TRIGGER immutable_rules BEFORE UPDATE OR DELETE ON __SCHEMA__.rules FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.immutable_fact();
CREATE TRIGGER immutable_decisions BEFORE UPDATE OR DELETE ON __SCHEMA__.decisions FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.immutable_fact();
CREATE TRIGGER immutable_catalogs BEFORE UPDATE OR DELETE ON __SCHEMA__.catalogs FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.immutable_fact();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON __SCHEMA__.audit FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.immutable_fact();
CREATE TRIGGER immutable_resolutions BEFORE UPDATE OR DELETE ON __SCHEMA__.resolutions FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.immutable_fact();
CREATE TRIGGER immutable_points BEFORE UPDATE OR DELETE ON __SCHEMA__.points FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.immutable_fact();

CREATE FUNCTION __SCHEMA__.line_creation_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM __SCHEMA__.ledger_events WHERE event_id=NEW.event_id AND created_txid=txid_current()) THEN RAISE EXCEPTION 'closed_journal'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER closed_journal BEFORE INSERT ON __SCHEMA__.ledger_lines FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.line_creation_only();
CREATE FUNCTION __SCHEMA__.balanced_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF (SELECT count(*) FROM __SCHEMA__.ledger_lines WHERE event_id=NEW.event_id)<2 OR
    (SELECT coalesce(sum(amount),1) FROM __SCHEMA__.ledger_lines WHERE event_id=NEW.event_id)<>0 THEN RAISE EXCEPTION 'unbalanced_journal'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER balanced_event AFTER INSERT ON __SCHEMA__.ledger_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.balanced_event();

CREATE FUNCTION __SCHEMA__.post_ledger(p_request text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE req jsonb; item jsonb; old __SCHEMA__.ledger_events; acct __SCHEMA__.accounts; journal_id uuid; event_seq bigint; prev text; raw text; digest text;
BEGIN
 IF length(p_request)>65536 THEN RAISE EXCEPTION 'invalid_posting'; END IF;
 req:=p_request::jsonb;
 IF jsonb_typeof(req)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(req))<>5 OR
    NOT(req ?& ARRAY['idempotency_key','currency','day','description','lines']) OR
    coalesce(req->>'idempotency_key','') !~ '^[A-Za-z0-9_-]{1,80}$' OR
    coalesce(req->>'currency','') NOT IN ('USD','EUR','JPY') OR
    coalesce(req->>'day','') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' OR
    coalesce(length(req->>'description'),0) NOT BETWEEN 1 AND 120 OR
    jsonb_typeof(req->'lines')<>'array' THEN RAISE EXCEPTION 'invalid_posting'; END IF;
 IF jsonb_array_length(req->'lines') NOT BETWEEN 2 AND 40 THEN RAISE EXCEPTION 'invalid_posting'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(req->'lines') LOOP
  IF jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>2 OR
     coalesce(item->>'account_id','') !~ '^[A-Za-z0-9_-]{1,80}$' OR
     jsonb_typeof(item->'amount_minor')<>'string' OR coalesce(item->>'amount_minor','') !~ '^-?[1-9][0-9]{0,17}$' THEN RAISE EXCEPTION 'invalid_posting'; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'account_id') FROM jsonb_array_elements(req->'lines'))<>jsonb_array_length(req->'lines') OR
    (SELECT sum((value->>'amount_minor')::numeric) FROM jsonb_array_elements(req->'lines'))<>0 THEN RAISE EXCEPTION 'unbalanced_posting'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('__SCHEMA__:ledger',0));
 digest:=encode(sha256(convert_to(p_request,'UTF8')),'hex');
 SELECT * INTO old FROM __SCHEMA__.ledger_events WHERE request_key=req->>'idempotency_key';
 IF FOUND THEN
  IF old.request_text<>p_request THEN RAISE EXCEPTION 'idempotency_conflict'; END IF;
  RETURN jsonb_build_object('event_id',old.event_id,'seq',old.seq::text,'hash',old.hash,'replayed',true);
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(req->'lines') ORDER BY value->>'account_id' LOOP
  SELECT * INTO acct FROM __SCHEMA__.accounts WHERE id=item->>'account_id' FOR UPDATE;
  IF NOT FOUND OR acct.currency<>req->>'currency' THEN RAISE EXCEPTION 'account_currency_mismatch'; END IF;
  IF NOT acct.allow_negative AND acct.balance+(item->>'amount_minor')::numeric<0 THEN RAISE EXCEPTION 'insufficient_balance'; END IF;
 END LOOP;
 journal_id:=gen_random_uuid();
 event_seq:=nextval(pg_get_serial_sequence('__SCHEMA__.ledger_events','seq'));
 SELECT hash INTO prev FROM __SCHEMA__.ledger_events ORDER BY seq DESC LIMIT 1;
 prev:=coalesce(prev,repeat('0',64));
 raw:=jsonb_build_object('event_id',journal_id::text,'seq',event_seq::text,'request',req)::text;
 INSERT INTO __SCHEMA__.ledger_events(seq,event_id,request_key,currency,request_text,request_digest,event_text,previous_hash,hash) OVERRIDING SYSTEM VALUE VALUES(event_seq,journal_id,req->>'idempotency_key',req->>'currency',p_request,digest,raw,prev,encode(sha256(convert_to(prev||raw,'UTF8')),'hex'));
 FOR item IN SELECT value FROM jsonb_array_elements(req->'lines') LOOP
  INSERT INTO __SCHEMA__.ledger_lines VALUES(journal_id,item->>'account_id',req->>'currency',(item->>'amount_minor')::numeric);
  UPDATE __SCHEMA__.accounts SET balance=balance+(item->>'amount_minor')::numeric WHERE id=item->>'account_id';
 END LOOP;
 INSERT INTO __SCHEMA__.audit(kind,body) VALUES('ledger_posted',jsonb_build_object('event_id',journal_id,'request_key',req->>'idempotency_key'));
 RETURN jsonb_build_object('event_id',journal_id,'seq',event_seq::text,'hash',encode(sha256(convert_to(prev||raw,'UTF8')),'hex'),'replayed',false);
END $$;

CREATE FUNCTION __SCHEMA__.repair_balances() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE changed bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('__SCHEMA__:ledger',0));
 UPDATE __SCHEMA__.accounts a SET balance=coalesce((SELECT sum(l.amount) FROM __SCHEMA__.ledger_lines l WHERE l.account_id=a.id),0);
 GET DIAGNOSTICS changed=ROW_COUNT;
 INSERT INTO __SCHEMA__.audit(kind,body) VALUES('projection_rebuilt',jsonb_build_object('accounts',changed));
 RETURN changed;
END $$;

GRANT SELECT ON ALL TABLES IN SCHEMA __SCHEMA__ TO tally_app;
GRANT INSERT(id,currency,allow_negative) ON __SCHEMA__.accounts TO tally_app;
GRANT INSERT ON __SCHEMA__.rules,__SCHEMA__.decisions,__SCHEMA__.catalogs,__SCHEMA__.points,__SCHEMA__.audit,__SCHEMA__.resolutions TO tally_app;
GRANT INSERT ON __SCHEMA__.recon_batches,__SCHEMA__.recon_matches TO tally_app;
GRANT INSERT,UPDATE ON __SCHEMA__.recon_exceptions,__SCHEMA__.feeds TO tally_app;
GRANT INSERT,DELETE ON __SCHEMA__.sessions TO tally_app;
GRANT USAGE,SELECT ON SEQUENCE __SCHEMA__.audit_id_seq TO tally_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA __SCHEMA__ FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __SCHEMA__.post_ledger(text),__SCHEMA__.repair_balances() TO tally_app;
