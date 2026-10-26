-- After 20261025800000: someone changed set_auto_backups (a comment). The rollback must refuse.
do $m$
declare d text := pg_get_functiondef('public.set_auto_backups(text,boolean)'::regprocedure);
begin
  execute replace(d, 'begin', E'begin\n  -- changed after 20261025800000');
end $m$;
