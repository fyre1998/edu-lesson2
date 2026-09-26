"""Reject Compose configurations that could accidentally target lesson 1."""
import json
import sys


def validate(config):
    def require(condition, message):
        if not condition:
            raise ValueError(message)

    require(config.get('name') == 'edu-lesson2', 'Wrong Compose project')
    services = config.get('services', {})
    require(set(services) == {'app', 'db'}, 'Only lesson 2 app and db may be deployed')
    expected_mounts = {
        'app': {'uploads': '/app/data'},
        'db': {'postgres': '/var/lib/postgresql/data'},
    }
    for name, service in services.items():
        require(not service.get('ports'), 'Lesson 2 must not publish host ports')
        require(not service.get('privileged'), 'Privileged containers are not permitted')
        require(not service.get('network_mode'), 'Explicit container networking is required')
        mounts = service.get('volumes', [])
        require(len(mounts) == 1, f'Unexpected storage for {name}')
        mount = mounts[0]
        require(mount.get('type') == 'volume', 'Host bind mounts are not permitted')
        require(expected_mounts[name].get(mount.get('source')) == mount.get('target'),
                f'Wrong storage mount for {name}')
    volumes = config.get('volumes', {})
    require(set(volumes) == {'uploads', 'postgres'}, 'Unexpected volume declarations')
    for key, volume in volumes.items():
        require(volume.get('name') == f'edu-lesson2_{key}', 'Wrong storage volume name')
        require(not volume.get('external'), 'Existing external volumes must not be reused')
        require(not volume.get('driver_opts'), 'External storage mappings are not permitted')
    networks = config.get('networks', {})
    require(set(networks) == {'default', 'gateway'}, 'Unexpected network declarations')
    require(networks['default'].get('name') == 'edu-lesson2_default', 'Wrong private network')
    require(not networks['default'].get('external'), 'Private network must be independent')
    require(networks['gateway'].get('name') == 'edu_gateway'
            and networks['gateway'].get('external'), 'Wrong reverse-proxy network')
    require(set(services['db'].get('networks', {})) == {'default'},
            'Database must remain on its private network')
    require(set(services['app'].get('networks', {})) == {'default', 'gateway'},
            'Application must use its private network and shared gateway')
    require('edu-lesson2-app' in services['app']['networks']['gateway'].get('aliases', []),
            'Missing unique application network alias')
    env = services['app'].get('environment', {})
    require(env.get('APP_ORIGIN') == 'https://lsclass.top', 'Wrong public origin')
    require(env.get('APP_BASE_PATH') == '/lesson', 'Wrong public path; lesson 2 requires /lesson')
    require(env.get('APP_INSTANCE_ID') == 'lesson2-production', 'Wrong application identity')
    database_url = env.get('DATABASE_URL', '')
    require(database_url.startswith('postgresql+psycopg://workbench:')
            and database_url.endswith('@db:5432/workbench'), 'Wrong database target')


if __name__ == '__main__':
    try:
        validate(json.load(sys.stdin))
    except (ValueError, KeyError, TypeError, IndexError) as error:
        print(f'Deployment refused: {error}', file=sys.stderr)
        sys.exit(1)
    print('Isolation checks passed: lesson 2 only')
