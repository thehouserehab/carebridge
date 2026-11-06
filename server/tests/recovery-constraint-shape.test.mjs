import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {RECOVERY_CONSTRAINT_QUERY} from '../recovery-state-comparison.mjs';

// Memory-only actual PostgreSQL parser/deparser, not a native restore proof.
// Exercises the SAME fixed metadata query consumed by the comparator.
test('CHECK dump reparse parentheses do not create a false mismatch or touch data',async()=>{
  const db=await PGlite.create();
  try{
    await db.exec(`CREATE TABLE public.cb_child_profiles(name text NOT NULL,
      CONSTRAINT cb_child_profiles_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 30 AND name=btrim(name)));
      INSERT INTO public.cb_child_profiles VALUES ('Synthetic');`);
    const before=(await db.query(RECOVERY_CONSTRAINT_QUERY)).rows;
    const raw=(await db.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='public.cb_child_profiles'::regclass AND conname='cb_child_profiles_name_check'`)).rows[0].definition;
    await db.exec('ALTER TABLE public.cb_child_profiles DROP CONSTRAINT cb_child_profiles_name_check');
    await db.exec(`ALTER TABLE public.cb_child_profiles ADD CONSTRAINT cb_child_profiles_name_check ${raw}`);
    const afterRaw=(await db.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='public.cb_child_profiles'::regclass AND conname='cb_child_profiles_name_check'`)).rows[0].definition;
    assert.notEqual(raw,afterRaw); // Reproduces the original false rejection.
    assert.deepEqual((await db.query(RECOVERY_CONSTRAINT_QUERY)).rows,before);
    assert.deepEqual((await db.query('SELECT name FROM public.cb_child_profiles')).rows,[{name:'Synthetic'}]);
  }finally{await db.close();}
});
test('actual weaker predicate, validation state and Boolean precedence remain distinguishable',async()=>{
  const db=await PGlite.create();
  try{
    await db.exec(`CREATE TABLE public.cb_child_profiles(name text,
      CONSTRAINT cb_child_profiles_name_check CHECK (length(name)>=1 AND length(name)<=30));`);
    const original=(await db.query(RECOVERY_CONSTRAINT_QUERY)).rows;
    for(const predicate of ['length(name)<=300','length(name)>=1 OR length(name)<=30']){
      await db.exec('ALTER TABLE public.cb_child_profiles DROP CONSTRAINT cb_child_profiles_name_check');
      await db.exec(`ALTER TABLE public.cb_child_profiles ADD CONSTRAINT cb_child_profiles_name_check CHECK (${predicate})`);
      assert.notDeepEqual((await db.query(RECOVERY_CONSTRAINT_QUERY)).rows,original);
    }
    await db.exec(`ALTER TABLE public.cb_child_profiles DROP CONSTRAINT cb_child_profiles_name_check;
      ALTER TABLE public.cb_child_profiles ADD CONSTRAINT cb_child_profiles_name_check CHECK (length(name)>=1 AND length(name)<=30) NOT VALID;`);
    assert.notDeepEqual((await db.query(RECOVERY_CONSTRAINT_QUERY)).rows,original);
  }finally{await db.close();}
});
