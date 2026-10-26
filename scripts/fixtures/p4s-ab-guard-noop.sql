-- Reached only when nothing before it refused.
do $t$ begin raise exception 'RESULT: 1 PASS, 0 FAIL :: PASS reached the end (nothing refused)'; end $t$;
