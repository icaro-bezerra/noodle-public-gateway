# Tutorial: publicando galerias do Noodle

Este guia leva do zero até galerias públicas no ar: cada endereço (`fotos-familia.seudominio.com`,
`casamento.seudominio.com`…) mostra o Noodle completo — fotos, álbuns, pessoas, mapa, busca — sem login e sem
permitir nenhuma alteração.

Todos os passos foram executados na prática contra um Noodle real; os nomes de botões estão como aparecem na
interface em português (alguns textos do Noodle ainda não têm tradução e aparecem em inglês; nesses casos o guia
usa o texto em inglês).

## Como funciona, em uma figura

```
visitante ─► casamento.seudominio.com ─┐
visitante ─► familia.seudominio.com ───┼─► Caddy (HTTPS) ─► public-gateway ─► Noodle
                                       │                     (escolhe a galeria pelo endereço,
você ──────► fotos.seudominio.com ─────┘── (direto, com login)  usa a chave só-leitura dela)
```

- **Cada galeria pública é um usuário do Noodle** criado só para isso. O que esse usuário enxerga é o que a
  galeria mostra.
- O gateway guarda uma **chave de API somente leitura** de cada usuário e a usa no lugar do visitante. O visitante
  nunca vê a chave e não consegue alterar nada: o gateway bloqueia, e mesmo que deixasse passar, a chave não tem
  permissão de escrita.
- Você e sua família continuam usando o Noodle normalmente pelo endereço de sempre, com login.

## Antes de começar

- O Noodle rodando com o `docker-compose.yml` oficial.
- Um domínio onde você possa criar registros DNS.
- Este repositório na branch `feat/public-gateway`.
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

O `buildx` vem do pacote `docker-buildx` (no Arch: `sudo pacman -S docker-buildx`). O primeiro build do servidor
leva vários minutos.

> **Por que trocar a imagem do servidor?** As galerias funcionam e ficam seguras com a imagem oficial, mas aí:
> a interface mostra botões de editar, apagar e enviar (que falham ao clicar), e três coisas dão erro — a lista de
> álbuns da busca `Ctrl+K`, o mapa dentro de um álbum e as atualizações ao vivo. A imagem desta branch corrige as
> três e esconde todos os controles de edição para os visitantes. Para quem entra com login, nada muda.

No `docker-compose.yml` do Noodle, troque a imagem do servidor:

```yaml
services:
  immich-server:
    image: noodle-gallery-server:publico # era ghcr.io/open-noodle/gallery-server:${IMMICH_VERSION:-release}
```

e aplique com `docker compose up -d`.

## 2. Decidir o que a galeria vai mostrar

Há três jeitos de dar conteúdo ao usuário da galeria. **Recomendado: um Space em que ele é Visualizador.**

| Jeito                                                               | Quando usar                                                                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Space, com o usuário da galeria como Visualizador** (recomendado) | Você escolhe foto a foto o que entra, as fotos continuam suas e saem da galeria quando você as tira do Space. Várias pessoas podem contribuir. |
| Fotos enviadas pelo próprio usuário da galeria                      | Uma galeria "independente" (por exemplo, fotos de um evento que você sobe só para ela).                                                        |
| Compartilhamento de parceiro (partner)                              | Publica **tudo** do parceiro, o que raramente é o que se quer. Evite.                                                                          |

O resto do guia usa o Space.

## 3. Criar o usuário da galeria

Entre no Noodle como administrador:

1. Clique no seu avatar (canto superior direito) → **Administração** → **Usuários**.
2. **Criar usuário** (canto superior direito).
3. Preencha:
   - **E-mail**: qualquer endereço único, não precisa existir (ex.: `galeria-casamento@seudominio.com`).
   - **Senha** e **Confirme a senha**: anote; você vai usar uma vez no passo 5.
   - **Nome**: o nome que aparece na galeria (ex.: `Casamento Ana & João`).
   - Desmarque **Exigir que o usuário altere a senha no primeiro login**.
   - Deixe **Usuário Administrador** desmarcado. **Nunca** use um administrador como galeria.
4. **Criar**.

> Se ao entrar como administrador aparecer o aviso "Nova versão disponível", é só fechar: ele aparece porque a
> imagem compilada se identifica com outro número de versão.

## 4. Montar o Space e adicionar o usuário

Ainda como você (o dono das fotos):

1. Barra lateral → **Spaces** → **Create Space**. Dê um nome (ex.: `Casamento`).
2. Dentro do Space, abra a aba **Members** → **Add Member**, escolha o usuário da galeria e clique em
   **Adicionar**. Ele entra como **Visualizador**, que é o que queremos — confira na lista de membros e não o
   promova a Editor.
3. Use **Adicionar fotos** para colocar no Space o que deve aparecer na galeria. Pode ser feito a qualquer momento;
   a galeria pública reflete na hora.

O que **não** aparece na galeria, mesmo estando no Space: fotos arquivadas, ocultas, na pasta trancada ou na
lixeira.

## 5. Criar a chave de API (como o usuário da galeria)

A chave precisa ser criada pelo próprio usuário da galeria:

1. Saia da sua conta e entre com o e-mail e a senha do passo 3.
2. Na primeira entrada aparece a apresentação do Noodle: avance por **Tema → Idioma → Privacidade do usuário →
   Aplicativo Móvel** e clique em **Feito**. (Não é obrigatória para a galeria funcionar, mas é rápida.)
3. Avatar → **Configurações da Conta** → abra **Chaves de API** → **Nova Chave de API**.
4. **Nome**: `galeria-publica`.
5. Em **Permissão**, marque **somente** estas 25 (use o campo **Pesquisar** para achar cada uma):

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

   Se a galeria for oferecer download dos arquivos originais (`downloadOriginal`, passo 7), marque também
   `asset.download`. **Não** use "Selecionar todos".

6. **Criar**. A chave aparece **uma única vez**: clique em **Copiar para a área de transferência** e só então em
   **Feito**.
7. Saia da conta. Você não vai mais precisar dessa senha.

## 6. Guardar a chave

No servidor, ao lado do `docker-compose.yml` do Noodle:

```sh
mkdir -p gallery-keys
printf '%s\n' 'COLE-A-CHAVE-AQUI' > gallery-keys/casamento.key
chmod 600 gallery-keys/casamento.key
```

Um arquivo por galeria. O gateway lê esses arquivos; a chave nunca vai para o `gateway.yaml` nem para o navegador.

> O container do gateway roda como o usuário `node` (uid 1000). Se o seu usuário no servidor não for o uid 1000,
> use `chmod 644` no arquivo ou ajuste o dono com `chown 1000`.

## 7. Configurar o gateway

Crie `gateway.yaml` ao lado do `docker-compose.yml`:

```yaml
upstream: http://immich-server:2283 # o nome do serviço do servidor no docker-compose.yml
listen: { host: 0.0.0.0, port: 8080 }
trustProxy: true # o Caddy (passo 9) fica na frente

galleries:
  - host: casamento.seudominio.com
    apiKeyFile: /run/secrets/casamento.key
    title: Casamento Ana & João
    features:
      people: true # pessoas e reconhecimento de rostos
      map: true # mapa e localização das fotos
      smartSearch: true # busca por conteúdo ("praia", "bolo")
      downloadOriginal: false # baixar o arquivo original
```

O que cada opção publica:

- **`people`** (padrão: desligado): nomes e rostos das pessoas. É dado biométrico (LGPD/GDPR); ligue só se as
  pessoas concordarem. Pessoas marcadas como ocultas no Noodle continuam ocultas.
- **`map`** (padrão: desligado): coordenadas, cidade e país de cada foto. Desligado, o gateway apaga toda a
  localização das respostas e recusa buscas por lugar.
- **`smartSearch`** (padrão: ligado): busca por conteúdo, que usa o serviço de machine learning.
- **`downloadOriginal`** (padrão: desligado): permite baixar o arquivo original. **O original carrega todos os
  metadados, inclusive GPS**, que o gateway não consegue remover — o gateway avisa no log se você ligar isso com
  `map: false`. Sem ele, os visitantes veem e ampliam as fotos em boa resolução (a versão de visualização).

Outras opções (limites de requisições, indexação por buscadores) estão comentadas em
[gateway.example.yaml](gateway.example.yaml). Por padrão os buscadores são instruídos a não indexar as galerias.

## 8. Subir o gateway

Acrescente ao `docker-compose.yml` do Noodle:

```yaml
public-gateway:
  container_name: noodle_public_gateway
  image: noodle-public-gateway
  volumes:
    - ./gateway.yaml:/etc/public-gateway/gateway.yaml:ro
    - ./gallery-keys:/run/secrets:ro
  depends_on:
    - immich-server
  restart: always
```

Ele não precisa de porta publicada: só o Caddy fala com ele. Suba com `docker compose up -d public-gateway` e
confira:

```sh
docker compose logs public-gateway
# Public gateway on 0.0.0.0:8080 → http://immich-server:2283 (casamento.seudominio.com)
```

## 9. DNS e HTTPS (Caddy)

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

   e declare o volume em `volumes:` no fim do arquivo (`caddy-data:`).

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

Usa nginx ou Traefik em vez de Caddy? Os requisitos são: preservar o cabeçalho `Host`, acrescentar o IP do
visitante em `X-Forwarded-For` e repassar WebSocket (`Upgrade`/`Connection`) em `/api/socket.io/`.

## 10. Conferir

Abra `https://casamento.seudominio.com` numa janela anônima. Deve:

- [ ] abrir direto nas fotos, **sem tela de login**;
- [ ] mostrar só o que está no Space (e o que o próprio usuário da galeria tiver enviado);
- [ ] **não** ter botões Enviar, notificações nem avatar no topo; nem Lixeira, Arquivar ou Pasta com senha na
      barra lateral;
- [ ] ao abrir uma foto, mostrar só ampliar, copiar, informações e apresentação — nada de favoritar, girar,
      editar ou apagar;
- [ ] em Pessoas e no Mapa, seguir o que você ligou em `features`.

Se algo destoar, veja [Problemas comuns](#problemas-comuns).

## Mais galerias

Repita os passos 3 a 6 para cada galeria (um usuário e uma chave por galeria), acrescente um bloco em
`galleries:` no `gateway.yaml` e o nome no `Caddyfile`. Então recarregue, **sem derrubar** as outras galerias:

```sh
docker kill -s HUP noodle_public_gateway   # relê gateway.yaml e as chaves
docker compose restart caddy               # só se mudou o Caddyfile
```

Se o `gateway.yaml` novo tiver erro, o gateway mantém a configuração anterior e escreve o motivo no log.

## Trocar ou revogar uma chave

- **Trocar** (rotina, ou se achar que vazou): entre como o usuário da galeria → Configurações da Conta → Chaves de
  API → **Trocar chave** na chave `galeria-publica`. Cole a nova chave no arquivo e mande `SIGHUP` (acima). A chave
  antiga para de funcionar na hora.
- **Tirar uma galeria do ar**: remova o bloco do `gateway.yaml` e mande `SIGHUP`. Para garantir, **Excluir chave**
  na conta do usuário da galeria.
- **Tirar uma foto da galeria**: tire-a do Space (ou arquive). Vale na próxima vez que o visitante carregar a
  página.

## Problemas comuns

| Sintoma                                           | Causa provável                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `404 Not found` em tudo                           | O endereço não está em `galleries:` exatamente como o visitante digita, ou o Caddy não está repassando o `Host`.                   |
| `502 Bad gateway`                                 | O gateway não alcança o servidor: confira `upstream` (nome do serviço e porta 2283) e se estão no mesmo `docker-compose.yml`.      |
| Galeria vazia                                     | O usuário da galeria não é membro do Space, ou o Space não tem fotos. Entre como ele no Noodle normal e veja se as fotos aparecem. |
| Fotos aparecem, mas sem pessoas ou mapa           | `people` ou `map` desligados no `gateway.yaml` (o padrão é desligado).                                                             |
| Botões de editar aparecem                         | O servidor ainda está com a imagem oficial: veja o passo 1.                                                                        |
| `Missing required permission` no log ou em avisos | Faltou marcar alguma permissão na chave (passo 5). Edite a chave (**Editar chave**) e marque a que falta.                          |
| `429 Too many requests`                           | Limite de requisições por visitante. Se for legítimo (muitas fotos por página), aumente `rateLimit.default` no `gateway.yaml`.     |
| Visitantes aparecem todos com o mesmo IP no log   | `trustProxy: true` não está ligado, ou o proxy na frente não envia `X-Forwarded-For`.                                              |

## O que fica de fora, por segurança

Mesmo que a conta do usuário da galeria tenha acesso, o visitante **não** vê: fotos arquivadas, ocultas, trancadas
ou na lixeira; e-mails de qualquer pessoa; caminhos de arquivo do servidor; pessoas que não fazem parte da galeria
(o servidor do Noodle deixaria um membro de Space ver o rosto de uma pessoa recortado de uma foto fora do Space —
o gateway bloqueia isso).

Limitações conhecidas: vídeos que o servidor não converteu são servidos a partir do arquivo original e podem
carregar a localização embutida (não verificado); e os nomes de pessoas de um Space são os que os membros do Space
veem, então publicar o Space publica esses nomes.

Para os detalhes técnicos, veja o [README](README.md).
