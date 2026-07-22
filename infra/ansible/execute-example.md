```bash
cd infra/ansible
source ~/.venvs/pixaeron-ansible/bin/activate
export ANSIBLE_CONFIG="$PWD/ansible.cfg"
```

```bash
ansible-playbook provision.yml --limit production --diff
```
