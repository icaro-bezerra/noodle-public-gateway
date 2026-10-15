# Tutorial: publicando galerias do Noodle

Este guia leva do zero até galerias públicas no ar: cada endereço (`casamento.seudominio.com`,
`familia.seudominio.com`…) mostra o Noodle completo — fotos, álbuns, pessoas, mapa, busca — sem login e sem permitir
nenhuma alteração.

Você descreve as galerias num arquivo (nome, endereço, Space) e o gateway cria sozinho o que cada uma precisa. Todos
os passos foram executados na prática contra um Noodle real; os nomes de botões estão como aparecem na interface em
português (alguns textos do Noodle ainda não têm tradução e aparecem em inglês; nesses casos o guia usa o inglês).

## Como funciona, em uma figura

```
visitante ─► casamento.seudominio.com ─┐
visitante ─► familia.seudominio.com ───┼─► Caddy ou cloudflared ─► public-gateway ─► Noodle
                                       │                            (escolhe a galeria pelo endereço,
você ──────► fotos.seudominio.com ─────┘── (direto, com login)       usa a chave só-leitura dela)
```

- **Cada galeria pública é um usuário do Noodle**, criado pelo gateway só para isso, e vê o que estiver nos Spaces
  dela. O que esse usuário vê é o que a galeria mostra.
- O gateway guarda uma **chave de API somente leitura** de cada usuário e a usa no lugar do visitante. O visitante
  nunca vê a chave e não consegue alterar nada: o gateway bloqueia, e mesmo que deixasse passar, a chave não tem
  permissão de escrita.
- Você e sua família continuam usando o Noodle normalmente pelo endereço de sempre, com login.

## Antes de começar

- O Noodle rodando com o `docker-compose.yml` oficial, e uma conta de administrador.
- Este repositório na branch `feat/public-gateway`.
- Para publicar na internet: um domínio onde você possa criar registros DNS **ou** o `cloudflared` instalado (sem
  conta; veja o passo 6).
- **Faça um backup do banco do Noodle.** O passo 1 troca a imagem do servidor por uma compilada desta branch, que
  pode aplicar migrações de banco. Migrações não voltam atrás.

## 1. Compilar as imagens

Na raiz do repositório:

```sh
# o servidor do Noodle desta branch (traz o "modo galeria pública" da interface)
docker buildx build --load -f server/Dockerfile -t noodle-gallery-server:publico .

# o gateway
docker build -f packages/public-gateway/Dockerfile -t noodle-public-gateway .
```

O `buildx` vem do pacote `docker-buildx` (no Arch: `sudo pacman -S docker-buildx`). O primeiro build do servidor leva
vários minutos.

> **Por que trocar a imagem do servidor?** As galerias funcionam e ficam seguras com a imagem oficial, mas aí a
> interface mostra botões de editar, apagar e enviar (que falham ao clicar), e três coisas dão erro: a lista de
> álbuns da busca `Ctrl+K`, o mapa dentro de um álbum e as atualizações ao vivo. A imagem desta branch corrige as três
> e esconde todos os controles de edição para os visitantes. Para quem entra com login, nada muda.

No `docker-compose.yml` do Noodle, troque a imagem do servidor:

```yaml
services:
  immich-server:
    image: noodle-gallery-server:publico # era ghcr.io/open-noodle/gallery-server:${IMMICH_VERSION:-release}
```

e aplique com `docker compose up -d`.

## 2. Montar os Spaces com as fotos

Cada galeria mostra um ou mais Spaces. Como administrador:

1. Barra lateral → **Spaces** → **Create Space**. Dê um nome (ex.: `Casamento`).
2. Use **Adicionar fotos** para colocar no Space o que deve aparecer na galeria. Pode ser feito a qualquer momento;
   a galeria pública reflete na hora.

Se você pular este passo, o gateway cria o Space vazio no passo 5 e você só adiciona as fotos depois.

> O Space precisa ser **seu** (do administrador cuja chave o gateway usa): o gateway só enxerga Spaces dos quais
> esse administrador participa, e só o dono ou um Editor pode adicionar membros. Um Space de outra pessoa com o mesmo
> nome não serve — o gateway criaria um novo, vazio.

O que **não** aparece na galeria, mesmo estando no Space: fotos arquivadas, ocultas, na pasta trancada ou na lixeira.

## 3. Criar a chave de administrador (uma vez só)

O gateway usa esta chave apenas para criar as galerias. Ainda como administrador:

1. Avatar → **Configurações da Conta** → abra **Chaves de API** → **Nova Chave de API**.
2. **Nome**: `public-gateway-admin`.
3. Em **Permissão**, marque **somente** estas 6 (use o campo **Pesquisar** para achar cada uma):

   ```
   adminUser.read      adminUser.create      adminUser.update
   sharedSpace.read    sharedSpace.create    sharedSpaceMember.create
   ```

4. **Criar**. A chave aparece **uma única vez**: clique em **Copiar para a área de transferência** e só então em
   **Feito**.
5. No servidor, ao lado do `docker-compose.yml` do Noodle:

   ```sh
   mkdir -p gateway
   printf '%s\n' 'COLE-A-CHAVE-AQUI' > gateway/admin.key
   chmod 644 gateway/admin.key
   ```

Com essas permissões a chave consegue criar e ler usuários, criar Spaces e adicionar membros — não consegue apagar
nada, ver fotos de ninguém nem mudar configurações do Noodle.

## 4. Descrever as galerias

Crie `gateway/gateway.yaml`:

```yaml
upstream: http://immich-server:2283 # o nome do serviço do servidor no docker-compose.yml
listen: { host: 0.0.0.0, port: 8080 }
trustProxy: true # há um Caddy ou cloudflared na frente (passo 6)
adminApiKeyFile: admin.key

galleries:
  - name: Casamento # vira o usuário da galeria
    hosts: [casamento.seudominio.com]
    spaces: [Casamento]
    features:
      people: true # pessoas e reconhecimento de rostos
      map: true # mapa e localização das fotos

  - name: Família
    hosts: [familia.seudominio.com]
    spaces: [Família, Viagens]
    features: { people: true }
```

Para cada galeria:

- **`name`**: o nome que aparece na galeria. Também identifica o usuário que o gateway cria
  (`Família` → `familia@public-gallery.local`), então **não o troque** depois — um nome novo vira uma galeria nova.
- **`hosts`**: os endereços pelos quais ela é aberta (pode ser mais de um).
- **`spaces`**: os Spaces que ela mostra.
- **`features`** (todas opcionais):
  - **`people`** (padrão: desligado): nomes e rostos das pessoas. É dado biométrico (LGPD/GDPR); ligue só se as
    pessoas concordarem. Pessoas marcadas como ocultas no Noodle continuam ocultas.
  - **`map`** (padrão: desligado): coordenadas, cidade e país de cada foto. Desligado, o gateway apaga toda a
    localização das respostas e recusa buscas por lugar.
  - **`smartSearch`** (padrão: ligado): busca por conteúdo ("praia", "bolo"), que usa o machine learning.
  - **`downloadOriginal`** (padrão: desligado): permite baixar o arquivo original. **O original carrega todos os
    metadados, inclusive GPS**, que o gateway não consegue remover. Sem ele, os visitantes veem e ampliam as fotos em
    boa resolução.

Outras opções (limites de requisições, indexação por buscadores) estão comentadas em
[gateway.example.yaml](gateway.example.yaml). Por padrão os buscadores são instruídos a não indexar as galerias.

## 5. Subir o gateway

Acrescente ao `docker-compose.yml` do Noodle:

```yaml
public-gateway:
  container_name: noodle_public_gateway
  image: noodle-public-gateway
  volumes:
    - ./gateway:/etc/public-gateway:ro
    - public-gateway-state:/var/lib/public-gateway # as chaves das galerias que ele cria
  depends_on:
    - immich-server
  restart: always
```

e declare o volume em `volumes:` no fim do arquivo (`public-gateway-state:`). Suba e acompanhe:

```sh
docker compose up -d public-gateway
docker compose logs -f public-gateway
```

Em poucos segundos aparece, para cada galeria:

```
{"event":"provisioned","gallery":"Casamento","created":"user","email":"casamento@public-gallery.local"}
{"event":"provisioned","gallery":"Casamento","created":"membership","space":"Casamento"}
{"event":"provisioned","gallery":"Casamento","created":"api key"}
{"event":"config","reason":"start","galleries":["casamento.seudominio.com", ...],"pending":0}
```

Ou seja: o gateway criou o usuário, colocou-o como **Visualizador** do Space, gerou a chave somente leitura e passou a
servir o endereço. Nas próximas vezes que subir, ele reaproveita tudo e não cria nada de novo. Se o Noodle ainda
estiver iniciando, o gateway tenta de novo a cada 10 segundos.

## 6. Publicar na internet

### Opção A: domínio próprio com Caddy (endereço fixo, HTTPS automático)

1. No seu provedor de DNS, crie um registro `A` (ou `CNAME`) para cada galeria apontando para o servidor:
   `casamento.seudominio.com → IP do servidor`.
2. Acrescente o Caddy ao `docker-compose.yml`:

   ```yaml
   caddy:
     image: caddy:2
     ports: ['80:80', '443:443']
     volumes:
       - ./Caddyfile:/etc/caddy/Caddyfile:ro
       - caddy-data:/data
     restart: always
   ```

   e declare o volume `caddy-data:` no fim do arquivo.

3. Crie o `Caddyfile`:

   ```
   casamento.seudominio.com, familia.seudominio.com {
   	reverse_proxy public-gateway:8080
   }

   # o Noodle normal, com login, para você e a família
   fotos.seudominio.com {
   	reverse_proxy immich-server:2283
   }
   ```

4. `docker compose up -d caddy`. O Caddy obtém os certificados HTTPS sozinho.

Usa nginx ou Traefik? Os requisitos são: preservar o cabeçalho `Host`, acrescentar o IP do visitante em
`X-Forwarded-For` e repassar WebSocket (`Upgrade`/`Connection`) em `/api/socket.io/`.

### Opção B: cloudflared, sem conta e sem domínio

O túnel rápido do Cloudflare publica a galeria num endereço `https://<palavras-aleatórias>.trycloudflare.com`, sem
conta, sem domínio e sem abrir portas. Um túnel por galeria, apontando para a porta do gateway:

```sh
cloudflared tunnel --url http://localhost:8080 --http-host-header casamento.seudominio.com
cloudflared tunnel --url http://localhost:8080 --http-host-header familia.seudominio.com
```

Cada comando mostra o endereço público dele. O **`--http-host-header` é obrigatório**: o gateway escolhe a galeria
pelo endereço, e sem esse parâmetro ele recebe o endereço aleatório do túnel, que não conhece, e responde 404. Com
ele, o valor precisa ser um dos `hosts` da galeria no `gateway.yaml` (pode ser um nome que só exista ali, como
`casamento.localhost`).

Limites do túnel rápido: **o endereço muda toda vez que o `cloudflared` reinicia**, e a Cloudflare o oferece para
testes, sem garantia de disponibilidade. Para um endereço fixo, use a opção A, ou um túnel nomeado do Cloudflare
(exige uma conta gratuita e um domínio).

> Se preferir não usar `--http-host-header`, acrescente o endereço do túnel aos `hosts` da galeria
> (`hosts: [casamento.seudominio.com, palavras-aleatorias.trycloudflare.com]`) — e atualize sempre que o túnel
> reiniciar.

## 7. Conferir

Abra o endereço da galeria numa janela anônima. Deve:

- [ ] abrir direto nas fotos, **sem tela de login**;
- [ ] mostrar só o que está nos Spaces da galeria;
- [ ] **não** ter botões Enviar, notificações nem avatar no topo; nem Lixeira, Arquivar ou Pasta com senha na barra
      lateral;
- [ ] ao abrir uma foto, mostrar só ampliar, copiar, informações e apresentação — nada de favoritar, girar, editar ou
      apagar;
- [ ] em Pessoas e no Mapa, seguir o que você ligou em `features`.

Se algo destoar, veja [Problemas comuns](#problemas-comuns).

## No dia a dia

Tudo é feito editando o `gateway/gateway.yaml`. **Ao salvar o arquivo, o gateway aplica sozinho em poucos
segundos**, sem reiniciar nada (os logs mostram `"reason":"file changed"`). Se o arquivo novo tiver erro, ele mantém o
que já estava no ar e escreve o motivo no log.

- **Nova galeria**: acrescente um bloco em `galleries:` e salve. Com Caddy, acrescente também o endereço ao
  `Caddyfile` (`docker compose restart caddy`); com cloudflared, suba mais um túnel.
- **Mudar o que uma galeria mostra**: edite `spaces`, `hosts` ou `features` e salve.
- **Pôr ou tirar fotos**: adicione ou remova do Space. Vale na próxima vez que o visitante carregar a página.
- **Tirar uma galeria do ar**: apague o bloco dela e salve — o endereço para de responder na hora. O usuário da
  galeria continua existindo no Noodle (o gateway nunca apaga nada); para removê-lo, vá em Administração → Usuários e
  exclua o usuário `nome@public-gallery.local`.
- **Trocar as chaves das galerias** (se achar que vazaram): `docker exec noodle_public_gateway rm
/var/lib/public-gateway/galleries.json && docker kill -s HUP noodle_public_gateway`. O gateway gera chaves novas e
  apaga as antigas. Uma chave revogada por outro meio também é substituída sozinha em até 5 minutos.

### Os usuários que o gateway cria

- Têm e-mail `<nome>@public-gallery.local` e uma senha aleatória que ninguém conhece — **ninguém entra com eles**.
- O gateway **só mexe em usuários desse domínio**. Uma conta pessoal nunca é alterada, mesmo que tenha o mesmo nome
  da galeria.
- Se você excluir um deles em Administração → Usuários, a galeria sai do ar: o Noodle deixa o usuário numa fila de
  exclusão por alguns dias, e o gateway não o traz de volta sozinho — o log explica (`provision-failed … waiting to
be removed`). Para voltar, restaure o usuário ali mesmo; para encerrar, tire a galeria do arquivo.

## Apêndice: o jeito manual

Se preferir não dar uma chave de administrador ao gateway, dá para criar cada galeria à mão e entregar ao gateway só a
chave somente leitura dela. Por galeria:

1. **Administração → Usuários → Criar usuário**: e-mail único qualquer, senha (anote), nome da galeria; desmarque
   **Exigir que o usuário altere a senha no primeiro login**; **nunca** marque **Usuário Administrador**.
2. No Space, aba **Members → Add Member**: escolha o usuário e **Adicionar** (ele entra como **Visualizador**).
3. Saia e entre como o usuário da galeria. Na apresentação, avance por **Tema → Idioma → Privacidade do usuário →
   Aplicativo Móvel → Feito**.
4. Avatar → **Configurações da Conta** → **Chaves de API** → **Nova Chave de API**, nome `galeria-publica`, marcando
   **somente** estas 25 permissões (mais `asset.download` se usar `downloadOriginal`):

   ```
   activity.read           album.read              album.statistics
   activity.statistics     asset.read              asset.statistics
   asset.view              assetFile.read          face.read
   folder.read             map.read                map.search
   memory.read             memory.statistics       person.read
   person.statistics       sharedSpace.read        sharedSpaceAsset.read
   stack.read              tag.read                user.read
   userConfig.read         userOnboarding.read     userPreference.read
   userProfileImage.read
   ```

5. Copie a chave (ela aparece uma vez só), salve em `gateway/casamento.key` e use no `gateway.yaml`:

   ```yaml
   galleries:
     - host: casamento.seudominio.com
       apiKeyFile: casamento.key
       title: Casamento
       features: { people: true, map: true }
   ```

Galerias manuais e automáticas podem conviver no mesmo arquivo; `adminApiKeyFile` só é necessário se houver alguma
automática. Para trocar a chave de uma galeria manual: entre como o usuário dela → **Chaves de API** → **Trocar
chave**, e cole a nova no arquivo.

## Problemas comuns

| Sintoma                                              | Causa provável                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `404 Not found` em tudo                              | O endereço não está em `hosts` exatamente como chega ao gateway. Com cloudflared, faltou `--http-host-header`; com Caddy, o `Host` não está sendo repassado. |
| `502 Bad gateway`                                    | O gateway não alcança o servidor: confira `upstream` (nome do serviço e porta 2283).                                                                         |
| Galeria não aparece e o log mostra `"pending":1`     | Veja a linha `provision-failed` logo acima: ela diz o que faltou.                                                                                            |
| `provision-failed` com `Missing required permission` | Faltou marcar alguma das 6 permissões na chave de administrador (passo 3). **Editar chave** e marque a que falta; o gateway tenta de novo sozinho.           |
| `provision-failed` com `more than one Space named`   | Há dois Spaces com o mesmo nome; renomeie um.                                                                                                                |
| Galeria vazia                                        | O Space não tem fotos, ou o Space listado não é do administrador (veja o aviso no passo 2).                                                                  |
| Fotos aparecem, mas sem pessoas ou mapa              | `people` ou `map` desligados (o padrão é desligado).                                                                                                         |
| Botões de editar aparecem                            | O servidor ainda está com a imagem oficial: veja o passo 1.                                                                                                  |
| `429 Too many requests`                              | Limite de requisições por visitante. Se for legítimo, aumente `rateLimit.default`.                                                                           |
| Todos os visitantes parecem ter o mesmo IP           | `trustProxy: true` não está ligado.                                                                                                                          |

## O que fica de fora, por segurança

Mesmo que a conta do usuário da galeria tenha acesso, o visitante **não** vê: fotos arquivadas, ocultas, trancadas ou
na lixeira; e-mails de qualquer pessoa; caminhos de arquivo do servidor; pessoas que não fazem parte da galeria (o
servidor do Noodle deixaria um membro de Space ver o rosto de uma pessoa recortado de uma foto fora do Space — o
gateway bloqueia isso).

Limitações conhecidas: vídeos que o servidor não converteu são servidos a partir do arquivo original e podem carregar
a localização embutida (não verificado); e os nomes de pessoas de um Space são os que os membros do Space veem, então
publicar o Space publica esses nomes.

Para os detalhes técnicos, veja o [README](README.md).
