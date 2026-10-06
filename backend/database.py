"""数据库连接池配置，给后台 AI 任务和页面请求留出连接余量。"""
import os

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url


def create_database_engine(url):
    try:
        pool_size = int(os.getenv('DB_POOL_SIZE') or '20')
        max_overflow = int(os.getenv('DB_MAX_OVERFLOW') or '10')
        if pool_size < 1 or max_overflow < 0:
            raise ValueError()
    except ValueError:
        raise RuntimeError('DB_POOL_SIZE 必须为正整数，DB_MAX_OVERFLOW 必须为非负整数') from None

    parsed = make_url(url)
    options = {'pool_pre_ping': True}
    if parsed.get_backend_name() == 'sqlite':
        options['connect_args'] = {'check_same_thread': False}
    # 内存 SQLite 使用原有的线程连接池，不接收队列连接池参数。
    if parsed.get_backend_name() != 'sqlite' or parsed.database not in (None, '', ':memory:'):
        options.update(pool_size=pool_size, max_overflow=max_overflow)
    return create_engine(url, **options)
