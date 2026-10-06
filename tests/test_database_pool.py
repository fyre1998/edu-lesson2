"""验证实际借还连接的容量，而不只检查配置值。"""
from contextlib import ExitStack

import pytest
from sqlalchemy.exc import TimeoutError

from backend.database import create_database_engine


def test_default_pool_handles_sixteen_jobs_and_page_connections(tmp_path, monkeypatch):
    monkeypatch.delenv('DB_POOL_SIZE', raising=False)
    monkeypatch.delenv('DB_MAX_OVERFLOW', raising=False)
    engine = create_database_engine('sqlite:///' + (tmp_path / 'pool.db').as_posix())
    try:
        with ExitStack() as stack:
            # 16个后台任务、8个学生刷新请求及1个教师请求。
            connections = [stack.enter_context(engine.connect()) for _ in range(25)]
            assert all(connection.exec_driver_sql('SELECT 1').scalar() == 1 for connection in connections)
        with engine.connect() as connection:
            assert connection.exec_driver_sql('SELECT 1').scalar() == 1
    finally:
        engine.dispose()


def test_configured_pool_enforces_limit_and_reuses_returned_connections(tmp_path, monkeypatch):
    monkeypatch.setenv('DB_POOL_SIZE', '2')
    monkeypatch.setenv('DB_MAX_OVERFLOW', '1')
    engine = create_database_engine('sqlite:///' + (tmp_path / 'limited.db').as_posix())
    engine.pool._timeout = 0.02
    try:
        with ExitStack() as stack:
            first = stack.enter_context(engine.connect())
            stack.enter_context(engine.connect())
            stack.enter_context(engine.connect())
            with pytest.raises(TimeoutError):
                engine.connect()
            first.close()
            with engine.connect() as reused:
                assert reused.exec_driver_sql('SELECT 1').scalar() == 1
    finally:
        engine.dispose()


@pytest.mark.parametrize('size,overflow', [('0','10'), ('20','-1'), ('invalid','10')])
def test_invalid_capacity_fails_before_connecting(monkeypatch, size, overflow):
    monkeypatch.setenv('DB_POOL_SIZE', size)
    monkeypatch.setenv('DB_MAX_OVERFLOW', overflow)
    with pytest.raises(RuntimeError, match='DB_POOL_SIZE'):
        create_database_engine('sqlite:///:memory:')


def test_in_memory_sqlite_still_works(monkeypatch):
    monkeypatch.setenv('DB_POOL_SIZE', '20')
    monkeypatch.setenv('DB_MAX_OVERFLOW', '10')
    engine = create_database_engine('sqlite:///:memory:')
    try:
        with engine.connect() as connection:
            assert connection.exec_driver_sql('SELECT 1').scalar() == 1
    finally:
        engine.dispose()
