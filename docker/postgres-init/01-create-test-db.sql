-- Runs once, when the Docker volume is first created: a separate, disposable database
-- for the integration tests (they DROP and rebuild its schema on every run).
CREATE DATABASE evolviq_test;
