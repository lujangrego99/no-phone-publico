set -e
mkdir -p ~/bin ~/.ssh ~/.shortcuts
B=http://127.0.0.1:8999
# known_hosts_np no va en el repo: armalo con la host key de TU VPS (verificá la huella antes)
[ -f ~/.ssh/known_hosts_np ] || { echo "falta ~/.ssh/known_hosts_np: ssh-keyscan -t ed25519 <ip-vps> > ~/.ssh/known_hosts_np"; exit 1; }
[ -f ~/.nophone.env ] || { echo "falta ~/.nophone.env con NP_VPS_HOST=<ip-vps>"; exit 1; }
curl -sf $B/tunel-np -o ~/bin/tunel-np
curl -sf $B/nophone -o ~/bin/nophone
rm -f ~/.shortcuts/"no-phone APAGAR" ~/.shortcuts/"no-phone PRENDER" ~/.shortcuts/"no-phone estado"  # reemplazados por un solo botón
curl -sf $B/no-phone -o ~/.shortcuts/no-phone
chmod 700 ~/bin/tunel-np ~/bin/nophone ~/.shortcuts/*; chmod 600 ~/.ssh/known_hosts_np
[ -f ~/.ssh/tunel ] && chmod 600 ~/.ssh/tunel
command -v adb >/dev/null || pkg install -y android-tools
# .bashrc: PATH y arranque del túnel al abrir Termux (solo si está PRENDIDO; tunel-np lo chequea)
sed -i '/tunel-np/d' ~/.bashrc 2>/dev/null || true
grep -q 'HOME/bin' ~/.bashrc 2>/dev/null || echo 'export PATH=$HOME/bin:$PATH' >> ~/.bashrc
echo '~/bin/tunel-np >/dev/null 2>&1  # no-phone: si está PRENDIDO, arranca el túnel al abrir Termux' >> ~/.bashrc
echo instalado
