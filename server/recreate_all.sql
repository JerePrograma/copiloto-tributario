-- Terminar conexiones y recrear "copiloto"
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'copiloto' AND pid <> pg_backend_pid();

DROP DATABASE IF EXISTS copiloto;
CREATE DATABASE copiloto;

-- Terminar conexiones y recrear "copiloto_shadow"
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'copiloto_shadow' AND pid <> pg_backend_pid();

DROP DATABASE IF EXISTS copiloto_shadow;
CREATE DATABASE copiloto_shadow;
