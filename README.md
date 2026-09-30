# Shorts Rank — versão Realtime Database

Esta versão usa:

- GitHub Pages
- Firebase Authentication anônima
- Firebase Realtime Database

A configuração do Firebase já foi colocada em `firebase-config.js`.

## O que você ainda precisa fazer

### 1. Ativar Authentication anônimo

No Firebase Console:

**Authentication > Sign-in method > Anonymous / Anônimo > Enable / Ativar**

Salve.

### 2. Ajustar as regras do Realtime Database

No Firebase Console:

**Realtime Database > Regras**

Substitua tudo por:

```json
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
```

Depois clique em **Publicar**.

Essas regras deixam ler/escrever apenas quem entrou pelo Authentication anônimo.

## 3. Publicar no GitHub Pages

Suba todos os arquivos desta pasta para a raiz do repositório.

Depois:

**GitHub > Settings > Pages**
- Source: Deploy from a branch
- Branch: main
- Folder: / (root)

## 4. ADM

Abra:

`https://SEU-USUARIO.github.io/SEU-REPOSITORIO/admin.html`

Cadastre os 10 Shorts e clique em **Salvar 10 Shorts**.

## 5. Jogar

Abra o `index.html` em dois navegadores/computadores.

Cada pessoa:
- escolhe foto;
- coloca nome;
- entra no lobby;
- clica em "Estou pronto!".

Quando ambos estiverem prontos, a partida começa.

## Realtime Database esperado

Depois que o site começar a ser usado, o banco ficará aproximadamente assim:

```text
config
  shorts
    0
    1
    ...
    9

room
  status
  currentRound
  players
    p1
    p2
  ready
  rankings
  picks
```

Não precisa criar nada manualmente no painel do Firebase.
O site cria tudo sozinho.


## Painel ADM invisível para os jogadores

A página do jogo (`index.html`) não contém mais botão, link ou texto apontando para o ADM.

Você acessa diretamente por:

`https://SEU-USUARIO.github.io/SEU-REPOSITORIO/admin.html`

O painel também mostra em tempo real:
- quem entrou;
- quem está pronto;
- rodada atual;
- posição que cada jogador confirmou naquela rodada;
- quando a partida terminar.

## Título automático

No ADM, cada Short tem o botão **Buscar título automaticamente**.

O painel usa o endpoint público oEmbed do YouTube, portanto não precisa de chave da YouTube Data API.
Ele busca o título publicado pelo vídeo e mantém o campo editável.

Observação: o oEmbed devolve o título publicado pelo YouTube, mas não garante uma tradução oficial em português.
Se o resultado vier em outro idioma, você pode editar manualmente o campo antes de salvar.


## Debug de jogadores

O ADM agora possui uma seção **Debug de jogadores**.

Para cada slot (`P1` e `P2`) você pode:
- adicionar um jogador de teste;
- escolher o nome dele;
- remover um jogador existente.

Se você remover alguém durante uma partida em andamento, o sistema volta automaticamente
ao lobby para evitar deixar a rodada em um estado impossível.


## Correção para duas abas no mesmo navegador

A versão v4 corrige um problema de teste em que uma aba duplicada podia herdar o
`sessionStorage` da primeira e ser reconhecida como o mesmo jogador.

Agora:
- duas abas diferentes podem entrar como P1 e P2;
- a segunda aba continua na tela de nome/foto até clicar em entrar;
- F5 na mesma aba continua reconhecendo o jogador;
- antes de dar Ready, cada jogador pode clicar em **Editar perfil** no lobby para trocar nome e foto.


## Versão v5

- tela de jogo em layout de gravação ocupando a viewport;
- ranking dos dois jogadores visível simultaneamente;
- contagem regressiva sincronizada antes da primeira rodada;
- vídeo inicia automaticamente em modo mutado;
- título comporta até duas linhas;
- avaliação fake aparece em animação antes de liberar as escolhas;
- escolhas só são habilitadas depois da animação.


## Versão v6 — sincronização de saída/reset

As telas agora reagem imediatamente às mudanças remotas:

- resetar a sala manda os jogadores de volta para a entrada;
- remover um jogador faz aquela aba sair imediatamente;
- voltar a partida para o lobby atualiza as duas telas sem F5;
- contagem, animações e estado local são cancelados corretamente ao sair;
- foi adicionado um comando para voltar todos ao lobby mantendo os jogadores conectados.


## Versão v7 — áudio

Ao começar cada Short:
- o site tenta iniciar o vídeo automaticamente com áudio;
- o volume é ajustado para 50%;
- no YouTube isso é feito via IFrame Player API;
- em vídeos MP4/WebM o volume do elemento HTML5 é ajustado diretamente;
- se o navegador bloquear autoplay com som, o player cai para autoplay mutado para não interromper a rodada.


## Versão v8

- corrige o scroll da página de configuração;
- o jogo continua ocupando a viewport sem scroll no desktop;
- a página de configuração volta a ter rolagem vertical normal.


## Versão v9

- confirmar uma posição não recria nem reinicia o player do vídeo;
- ao clicar em uma posição, antes da confirmação, os dois jogadores enxergam em tempo real onde aquela pessoa está pensando em colocar o Short;
- cancelar a confirmação remove esse estado;
- confirmar adiciona o Short ao ranking dos dois lados com animação de encaixe;
- a animação acontece nas duas telas porque o estado vem do Realtime Database.


## Versão v10 — correção de lobby

- o listener em tempo real não escreve mais no banco só por receber uma atualização;
- a entrada de P1/P2 é confirmada pelo snapshot final da transação;
- o segundo jogador aparece imediatamente no lobby do primeiro;
- sala vazia não troca mais o identificador da aba desnecessariamente;
- contagem de conectados usa apenas slots realmente preenchidos.


## Versão v11

- vídeos ficam em loop por padrão;
- ao terminar a partida, o vídeo atual é pausado e mutado;
- resultado final ficou mais compacto, com scroll interno estilizado;
- cada Short recebe uma cor fixa, igual nos rankings dos dois jogadores;
- resultado faz um reveal rápido por Short, mostrando simultaneamente onde o mesmo vídeo ficou para cada pessoa;
- foto de perfil agora abre uma ferramenta de recorte quadrado com arraste e zoom antes de ser usada.


## Versão v12

- em cada ranking, vídeos já posicionados mostram discretamente em qual posição o outro jogador colocou o mesmo vídeo;
- reveal final agora percorre Short por Short e destaca simultaneamente a posição dele em P1 e P2;
- cada Short fica em destaque por cerca de 0,7 s antes de passar ao próximo;
- layout foi comprimido para aproveitar melhor telas 1080p;
- contagem regressiva ganhou visual de película/cinema antigo com sweep circular, tremor e flicker;
- estado "pensando nessa posição" está mais chamativo e permite o texto quebrar linha sem cortar.


## Versão v13

- removido o título/logo do topo para liberar mais espaço;
- removido o botão "Copiar resumo";
- durante o jogo não aparece mais "outro: #X";
- no resultado, cada vídeo mostra discretamente `Nome do outro jogador: #posição`;
- confetes voltaram e aparecem ao concluir o reveal final;
- countdown manteve o anel girando, mas sem textura/riscos/flicker de filme antigo;
- confirmação de posição ganhou mais impacto visual;
- inserção do vídeo no ranking recebeu brilho, ring e pop mais fortes;
- reveal final recebeu mais animação e destaque.


## Ajuste de ícones

- ícone do alternador de tema centralizado com SVGs próprios;
- animação circular/ripple ao alternar entre claro e escuro;
- favicon redesenhado inspirado no ícone de Shorts, em azul/ciano.


## Transição de tema

- removido o wipe/círculo expansivo;
- troca claro/escuro agora usa apenas transições suaves de fundo, painéis, bordas e textos.


## Ajustes de animação e resultado

- countdown ocupa a viewport inteira desde o primeiro frame e anima 3, 2, 1 em tamanho grande até o centro;
- avaliação de pessoas que gostaram agora é uma animação de tela inteira;
- resultado final não usa popup nem scroll interno e evita scroll horizontal;
- posições no resultado ganharam mais destaque;
- títulos longos fazem marquee ao passar o mouse e mostram tooltip completo.


## Ajustes visuais e transições

- resultado final centralizado e sem scroll interno/horizontal;
- nome/posição do outro jogador alinhados e número destacado;
- countdown inicial corrigido para viewport inteira desde o primeiro frame;
- reveal de aprovação agora cobre apenas a área do Short;
- títulos centralizados e marquee/tooltip reforçados;
- melhor contraste dos botões e estado pensando no tema claro;
- transição curta 3-2-1 entre Shorts;
- suspense antes de revelar o resultado após o décimo Short.


## Ajustes desta revisão

- confirmação sem corte nas bordas;
- marquee e tooltip nos títulos do ranking;
- aprovação cobre todo o painel central e ganhou foguinhos;
- transição entre Shorts sincronizada em 3 segundos para ambos;
- suspense final sincronizado;
- colunas laterais mais largas e mais margem inferior;
- contraste reforçado no tema claro.


## Revisão de sincronização e jogadores
- confirmação fica visível por 1 segundo antes do 3-2-1;
- próximo Short é pré-carregado pausado atrás da transição e só começa ao fim da contagem;
- P1/P2 têm cores próprias nas colunas;
- cursores de ambos são sincronizados e identificados por cor/nome;
- toast do tema claro ganhou contraste;
- favicon ganhou contorno preto.


## Cursor remoto responsivo

- o cursor não usa mais apenas porcentagem da tela inteira;
- durante a partida, a posição é normalizada dentro da área real do jogo;
- no lobby, a posição é normalizada dentro da área do lobby;
- resoluções diferentes (4K, 1080p, 720p) convertem a posição para a área equivalente local;
- resize e mudanças responsivas recalculam a posição dos cursores remotos.


## Cursor multiplayer em todo o site

- cursor sincronizado funciona na entrada, lobby, gameplay e resultado;
- botão "Estou pronto" e alternância claro/escuro também entram na área rastreada;
- dentro do jogo/lobby continua usando superfícies específicas para preservar precisão entre resoluções;
- fora dessas áreas usa a tela ativa inteira;
- cursor nativo do navegador fica oculto apenas para os jogadores;
- painel de configuração mantém o cursor normal.


## Cursor em viewport inteira

- o cursor sincronizado agora usa sempre a viewport inteira como referência;
- funciona igualmente sobre tema claro/escuro, editar perfil, pronto, modais, rankings e resultado;
- posição é enviada como porcentagem X/Y da tela visível;
- resoluções diferentes convertem essa porcentagem para a viewport local;
- o cursor real continua oculto no site dos jogadores.


## Lobby/menu comum

- site abre direto no lobby P1 vs P2;
- título central: "Julgando SHORTS";
- cada slot tem cor suave correspondente ao cursor;
- vagas abertas possuem botão Entrar;
- clicar no avatar/nome de uma vaga entra naquele slot e abre edição;
- depois de entrar, o próprio card mostra "Editar nome e foto";
- transição curta sincronizada visualmente entre lobby e gameplay;
- cursor remoto vira ponteiro sobre elementos clicáveis;
- cliques/seleções recebem um flash compartilhado na cor do jogador.


## Cursor + cores dos jogadores

- cursor local renderiza imediatamente e não depende do retorno do Firebase;
- cursores remotos continuam sincronizados pela viewport inteira;
- P1 continua ciano por padrão;
- P2 agora é laranja por padrão;
- edição de perfil possui paleta com 8 cores;
- cor escolhida acompanha cursor, card do lobby, coluna da gameplay e destaque de seleção;
- seleção compartilhada usa a cor real escolhida pelo jogador.


## Cursor antes de entrar

- antes de escolher Player 1 ou Player 2, o cursor normal do navegador continua visível;
- links e botões usam o pointer normal;
- ao entrar em um dos lados, o cursor nativo desaparece;
- dali em diante fica apenas o cursor customizado/sincronizado;
- Player 1 e Player 2 aparecem em negrito no texto do lobby.


## Lobby simétrico

- clicar em Entrar já abre imediatamente a edição de nome, foto e cor;
- cards P1/P2 reservam exatamente o mesmo espaço para perfil, edição e status;
- o lado que não pode editar mantém um botão invisível apenas como espaçador;
- área de "Estou pronto" possui largura/altura fixas;
- texto de status reserva altura fixa para não deslocar a interface entre os jogadores.


## Lobby sem scroll

- lobby ajustado para caber em 100vh sem scroll vertical;
- scroll horizontal bloqueado;
- cards e área de ações comprimem de forma responsiva em telas mais baixas;
- VS centralizado verticalmente entre os dois cards;
- VS recebe animação leve de deslocamento lateral e rotação suave.


## Perfil sincronizado

- nome, foto e cor são salvos juntos;
- ambos os jogadores veem a mesma animação curta de atualização;
- cursor muda de cor imediatamente;
- card do lobby e coluna da gameplay usam a cor escolhida;
- a animação só roda para mudanças recentes, não em reloads antigos.


## Correção de conexão

- corrigido erro em renderLobby que deixava o lobby preso em "conectando...";
- animação de mudança de perfil agora é chamada somente depois do card ser renderizado.


## Lobby polish

- após entrar como P1/P2, o outro lado fica visualmente bloqueado neste navegador;
- botões do outro lado permanecem no mesmo espaço, mas aparecem desabilitados;
- área "Estou pronto" ganhou padding inferior;
- texto de entrada ganhou mais respiro entre Player 1 e Player 2;
- VS agora usa a classe real `.versus-badge`, fica centralizado e anima suavemente.


## VS

- movimento alterado para um vai-e-vem contínuo;
- usa apenas dois extremos com `alternate`, evitando mudanças de direção intermediárias;
- rotação acompanha suavemente o deslocamento horizontal.


## Ajuste visual

- maior separação entre botão de perfil e status de confirmação;
- botão do perfil ficou um pouco mais largo e confortável;
- animação do VS agora é linear, mantendo velocidade constante até as extremidades.


## Revisão de interação e visual

- Enter no editor de perfil salva o perfil e não confirma “Estou pronto”;
- cursor temático usa a viewport inteira e também rastreia sobre a área do Short;
- ADM pode ligar/desligar a substituição pelo cursor temático;
- contagem 3–2–1 não mostra aprovação; a aprovação aparece depois da contagem e antes do Short;
- fundo recebeu tom mais verde;
- posições 1–10 usam cores do verde ao vermelho;
- ADM pode personalizar individualmente as 10 cores.


## Correção fase 2 / Short

- overlay de transição é removido explicitamente antes da nova rodada;
- botões 1–10 voltam a receber clique normalmente em todas as rodadas;
- próximo Short não é mais montado dentro do player visível durante o 3–2–1;
- após a aprovação, o player é criado novamente com o mesmo comportamento original;
- vídeo anterior é limpo enquanto a transição está cobrindo o palco;
- com cursor temático ativo, uma camada transparente permite acompanhar o mouse sobre o iframe do YouTube e clicar para pausar/continuar;
- com cursor temático desligado, o iframe continua interativo normalmente com o cursor nativo.


## Contagens / reveal

- contagem inicial agora é 3 → 2 → 1 → JULGUE, sem flash de 4;
- transição entre Shorts também é 3 → 2 → 1 → JULGUE;
- depois de JULGUE aparece a quantidade de pessoas que gostaram;
- iframe/vídeo do Short só é criado depois que a animação de aprovação termina;
- tela de aprovação é opaca desde o primeiro frame para impedir qualquer spoiler visual.


## VS / seleção / tema / favicon

- VS mantém o texto parado e gira somente o bloco azul lentamente;
- seleções são destacadas imediatamente no navegador local e espelhadas via Firebase;
- destaque usa a cor escolhida pelo jogador;
- seleção não altera mais `position` ou `transform` do controle clicado;
- botão claro/escuro mantém posição fixa e aplica o tema de forma explícita;
- favicon recebeu contorno preto externo e no símbolo de play para contraste em abas claras.


## Correção de áudio ao voltar ao lobby

- reset da sala para/muta e remove o player atual;
- "voltar todos ao lobby" também destrói o iframe/vídeo antes da troca de tela;
- overlays de aprovação/transição são ocultados junto;
- nenhum áudio do Short continua tocando invisível no lobby.


## ADM: alterações não salvas e acompanhamento ao vivo

- qualquer mudança nos Shorts, votos, títulos, cursor temático ou cores marca o painel como "não salvo";
- uma barra fixa aparece no rodapé perguntando se deseja salvar;
- a barra usa o mesmo salvamento do botão principal e some após sucesso;
- fechar/recarregar a aba com alterações pendentes dispara o aviso nativo do navegador;
- acompanhamento ao vivo mostra jogadores, estado da partida, rodada, Short atual, votos, seleção/confirmacão de cada jogador e os dois rankings 1–10 em tempo real.


## Novidades desta versão (v2)

### Cursores na posição exata entre telas diferentes
- O cursor não é mais enviado só como porcentagem da janela. Cada movimento envia
  o **elemento exato** debaixo do mouse (botão 3, slot 5 do ranking, card do P2,
  área do vídeo...) e a posição relativa dentro dele, com os elementos pais como reserva.
- O outro navegador acha o mesmo elemento na tela dele e desenha o cursor no mesmo
  ponto — funciona entre 1080p e 4K, zoom 100% e 125%, com ou sem barra de favoritos.
- Em teste com telas diferentes, o erro médio caiu de ~40–110 px para ~1–5 px.
- A ponta da seta/dedo do cursor agora fica exatamente no ponto do clique.
- Movimento interpolado (liso) e a última posição sempre é enviada quando o mouse para.
- O cursor some quando o mouse sai da janela e é limpo sozinho se a aba cair (onDisconnect).

### Relógio sincronizado com o servidor
- Contagens, transições e pausas usam o relógio do servidor do Firebase
  (`.info/serverTimeOffset`). Se um PC estiver com o relógio alguns segundos adiantado,
  o 3 → 2 → 1 continua igual nos dois.

### "Quantas pessoas gostaram" mais animado
- Listras diagonais infinitas no container central (só nele), reações subindo
  (👍 ❤️ 🔥 😂...), número tremendo enquanto conta, "SLAM" final com onda de choque,
  confete e barra de progresso. Sai com uma "cortina" subindo antes do Short aparecer.
- A transição 3 → 2 → 1 → JULGUE! entre Shorts também usa as listras e anéis.

### Mais "juicy"
- Botões 1–10: entrada em cascata, hover que levanta, clique que afunda + partículas.
- Popup de confirmação com a posição grande na cor dela e cadeado que fecha ao travar.
- Carimbo "TRAVADO #N" no palco e confete no slot do ranking (visível pros dois).
- Lobby: confete e carimbo quando alguém fica pronto; botão "Estou pronto!" pulsa
  quando só falta você.
- Anel de clique na cor do jogador, espelhado no navegador do outro.

### Qualidade de vida
- Atalhos: teclas **1–9 e 0** escolhem a posição, **Enter** confirma, **Esc** volta/fecha popups.
- O selo de status do jogo não fica mais escondido embaixo do botão de tema.
- Resquícios roxos do tema antigo trocados pelos tons ciano/verde-azulados.
- A página de jogo não "sobe" mais alguns pixels depois de um F5.
- Funciona mesmo aberto por http na rede local (fallback para `crypto.randomUUID`).


## Novidades desta versão (v3)

- **Carregando infinito corrigido:** o site ligava os "ouvintes" do banco antes do login anônimo
  terminar; na primeira visita o Firebase negava a leitura e nunca mais tentava (no F5 o login já
  estava salvo). Agora ele faz login primeiro e religa sozinho se a conexão cair.
- **JULGUE! → curtidas sem tela preta:** uma única capa listrada cobre o palco do 3-2-1 até o fim
  do número de curtidas; o número já entra enquanto o JULGUE! sai.
- **Posições usadas** aparecem riscadas desde o começo da rodada.
- **Troca de tema** com círculo nascendo do botão (View Transitions; navegadores antigos trocam direto).
- **Player estilo Shorts:** passar o mouse mostra play/pause, volume (com barra) e progresso clicável.
  O volume escolhido continua nos próximos Shorts.
- **Vídeo de fundo desfocado** no palco (liga/desliga, desfoque e visibilidade no ADM). Aparece só
  quando o player confirma que está tocando; carregando/pausado/erro → cor padrão. Textos ganham borda.
- **Final:** sem 3-2-1 — suspense de ~3 s com tambores.
- **Pausa de ~3,6 s** depois que os dois escolhem ("Os dois escolheram!").
- **Cartas 3D** no lobby (inclinam com o mouse, e o outro jogador vê a mesma inclinação).
- Card do outro jogador com selo de cadeado e borda tracejada (sem transparência, mesmo tamanho).
- Popup de perfil só fecha pelo **X** ou "Cancelar".
- Paleta mais Problems/ciano nos dois temas, com grade de hexágonos no fundo.
- Cores do resultado = cores dos botões 1–10.
- **ADM novo:** abas (Shorts / Visual), prévia das capas, arrastar para reordenar, buscar todos os
  títulos, sortear curtidas, painel ao vivo sempre visível, jogadores de teste com "Pronto",
  botão Descartar e Ctrl+S para salvar.

### v4
- Resultado: passar o cursor num Short destaca o mesmo Short na lista do outro jogador (os dois veem).
- Títulos longos: o marquee fica preso na própria caixa e o balão aparece ACIMA do texto.
- Resultado final sempre cabe na tela, sem scroll.
- Suspense final: "Preparando os resultados..." com pontinhos animados.
- Pausa depois que os dois escolhem: ~3,6 s.
- Botão de preferências (ao lado do tema), só para aquele computador: cursor colorido ou
  "só o nome" (cursor normal + nome seguindo) e vídeo de fundo Padrão do ADM / Ligado / Desligado.
- Contagem inicial só com o número, com anel que esvazia e cor diferente para 3, 2 e 1.

### v5
- JULGUE! da contagem inicial fica ~1,6 s na tela.
- Resultado: o destaque cruzado só funciona depois da chuva de confete.
- Player com a proporção real de Short (9:16) — antes ele ficava quase quadrado, com faixas pretas.

### v6
- **Sincronizar o Short (🔗):** botão no topo do player. Quando OS DOIS ativam, pausar, tocar e
  avançar/voltar a minutagem acontece igual nos dois navegadores (com correção de tempo a cada 2,5 s).
  Se só um ativar, o botão do outro pisca "O outro quer sincronizar!". Desliga ao voltar ao lobby.
- Fim da contagem inicial com mini animação (o conteúdo dá zoom e a tela fecha em círculo).

### v7
- Voto mais leve e confiável: confirmar a posição grava só os 3 campos do próprio jogador (antes era
  uma transação na sala inteira, com as fotos, disputando com o outro navegador).
- Mudanças de fase feitas pelo P1 (P2 só entra se o P1 não fizer em ~1 s): menos conflito.
- Título longo não empurra mais os botões 9 e 10 para fora do palco em telas menores.
- Foto (ou inicial) de quem confirmou cada posição aparece no próprio botão, para os dois;
  passar o cursor mostra o nome.
- Botão 🔗 vira só ícone em player estreito; o aviso aparece numa linha própria.

### v8
- Fotos nos botões só do Short atual: pulsando quando o jogador só selecionou (pensando),
  normal quando confirmou. Tooltip com o nome ao passar o cursor.
- Troféu (#1), medalha de prata (#2) e bronze (#3) aparecem no centro para os dois, com a foto de quem escolheu.
- Brilho dos botões corrigido (não vaza mais para fora).
- JULGUE! → jogo com transição suave (fade + leve desfoque).

### v9
- JULGUE! → jogo: cortina subindo de baixo pra cima (com borda dourada) revelando o jogo.
  Corrigido também: antes o jogo escondia a contagem na hora e cortava a animação de saída.
