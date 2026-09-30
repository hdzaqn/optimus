# Optimus · apontamentos

Aplicativo da HB System para importar uma planilha, conferir cada linha com as agendas do Optimus e enviar apenas apontamentos válidos. Inclui painel de horas e relatórios CSV/PDF.

## Desenvolvimento

```bash
npm ci
npm run build
npm test
```

O aplicativo usa as APIs de login, agendas e apontamentos por meio de Cloudflare Pages Functions. A planilha é lida no navegador. A senha é enviada ao Optimus para autenticação e o token fica em cookie HttpOnly.

## Publicação

O endereço combinado é `https://hbsystem.app/optimus`. Ele é atendido hoje pelo projeto Cloudflare Pages `habi`, ligado ao repositório [hdzaqn/habi](https://github.com/hdzaqn/habi). Este repositório contém o aplicativo independente, mas publicar somente aqui não troca a aplicação naquele caminho: é necessário configurar uma rota reversa no domínio antes de alterar a origem de produção. Até essa configuração, o deploy de produção permanece via Git do `habi`.

No painel e nos relatórios, as horas são calculadas pelo intervalo das agendas. A API consultada não confirmou um valor por hora do analista, então não há cálculo financeiro.
