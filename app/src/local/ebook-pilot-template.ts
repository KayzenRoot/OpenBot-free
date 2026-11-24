const title = "Git com IA — revise antes de aplicar";
const audience =
  "Quem programa no dia a dia e quer usar IA para corrigir código com Git.";
const promise =
  "Transforme uma tarefa pequena em um patch revisado, testado e pronto para aplicar.";

export const ebookPilot = {
  title,
  author: "OpenBot Local",
  audience,
  promise,
  coverTheme: "verde" as const,
  sources: [
    {
      title: "Documentação do Git worktree",
      url: "https://git-scm.com/docs/git-worktree",
    },
    {
      title: "Documentação do Git diff",
      url: "https://git-scm.com/docs/git-diff",
    },
    {
      title: "Permissões do OpenCode",
      url: "https://opencode.ai/docs/permissions",
    },
  ],
  outline: [
    "Comece com uma tarefa verificável",
    "Separe a proposta do código em uso",
    "Revise o diff e prove o comportamento",
    "Aplique com uma decisão explícita",
  ],
  chapters: [
    {
      title: "Comece com uma tarefa verificável",
      text: [
        "A IA trabalha melhor quando recebe uma mudança que cabe em uma frase e um resultado que você consegue verificar. “Melhore a validação” deixa muitas decisões abertas. “Recuse nomes formados só por espaços, aceite nomes válidos e mantenha a mensagem de erro existente” já descreve o que preservar e o que mudar.",
        "Escolha o menor trecho de código necessário. Para esse exemplo, geralmente bastam o validador e um teste conhecido. Use caminhos relativos ao repositório e confira o conteúdo antes de enviá-lo ao modelo. Um exemplo inventado ou anonimizado quase sempre serve para explicar um formato de entrada sem expor dados de clientes.",
        "Escreva uma condição de aceite antes de pedir o primeiro patch. Para o nome, especifique se espaços no começo e no fim devem ser removidos, o resultado para uma string vazia e qual mensagem o chamador recebe. Se houver dúvida sobre nomes de outros idiomas, acrescente um caso com acentos.",
        "Exercício. Pegue uma tarefa do seu backlog e escreva três linhas: comportamento atual, comportamento esperado e o teste que demonstra a diferença. Se você precisar explicar várias funcionalidades ao mesmo tempo, escolha uma delas para a primeira proposta.",
      ].join("\n\n"),
    },
    {
      title: "Separe a proposta do código em uso",
      text: [
        "Antes de editar, rode git status --short e git rev-parse HEAD. O primeiro comando mostra o trabalho local que está em andamento. O segundo identifica o commit a partir do qual a proposta será avaliada. Uma mudança ainda fora de um commit precisa ser tratada separadamente, porque não faz parte desse ponto de partida.",
        "Uma worktree é uma segunda pasta de trabalho para o mesmo histórico Git. Ela permite abrir a proposta lado a lado com o projeto em uso. No OpenBot, escolha a pasta e os arquivos da tarefa, gere a proposta e confira a pasta criada para revisão. Você pode voltar ao projeto original enquanto avalia a cópia.",
        "Trate comandos de projeto com o cuidado de código executável. Antes de rodar um teste, saiba de onde vieram o arquivo e as dependências. Prefira um teste direcionado e conhecido. No primeiro ensaio, um validador puro com a biblioteca de testes do runtime é suficiente para praticar sem banco, navegador ou servidor.",
        "Exercício. Compare o commit registrado com o mostrado no painel e verifique a pasta original depois da proposta. A evidência que você quer guardar é a relação entre o commit de origem, os arquivos selecionados e a mudança exibida na revisão.",
      ].join("\n\n"),
    },
    {
      title: "Revise o diff e prove o comportamento",
      text: [
        "Leia o diff começando pelo objetivo da tarefa. Para cada arquivo, pergunte qual condição mudou e que chamador usa essa condição. Um ajuste que toca módulos extras precisa de uma justificativa. Procure também mudanças acidentais de formatação, contratos de retorno e mensagens usadas em testes.",
        "Rode o teste com o caso que motivou a correção e um caso que já funcionava. No exemplo dos nomes, acrescente uma entrada composta por espaços e outra com um nome válido. Quando a alteração mexer em um comportamento compartilhado, rode também os testes dos chamadores relevantes.",
        "Guarde a saída real da execução. Um teste que deixou de carregar devido a uma dependência ausente não demonstra o comportamento. Um teste que passou sem alcançar o ramo modificado também tem alcance limitado. Depois do teste, confira novamente o diff para saber se algum arquivo inesperado foi alterado pelo comando.",
        "Exercício. Escreva uma frase de revisão com a mudança, um teste executado e o comportamento preservado. Esse resumo deve permitir a outra pessoa decidir se vale a pena aplicar a proposta.",
      ].join("\n\n"),
    },
    {
      title: "Aplique com uma decisão explícita",
      text: [
        "Antes de aplicar, confira se a branch de destino ainda corresponde à base usada na proposta. Se a branch avançou, releia os arquivos afetados e verifique se as premissas do patch continuam válidas. Teste novamente depois de resolver qualquer conflito.",
        "Você pode guardar o patch e examiná-lo com git apply --check caminho-do-patch antes de alterar a branch de destino. Esse comando verifica se o patch pode ser aplicado. A decisão de aplicá-lo vem depois da revisão e da verificação dos testes.",
        "Registre o motivo da alteração e o resultado que você conferiu. Depois de aplicar, use git status --short e git diff para confirmar que só entraram os arquivos esperados. Para um trabalho compartilhado, inclua no pedido de revisão o teste executado e os limites da prova.",
        "Seu roteiro de bolso: defina a tarefa, fixe a base, selecione o contexto, gere em uma cópia, leia o diff, rode os testes e decida se vai aplicar. Use o mesmo roteiro em uma correção pequena antes de aumentar o escopo.",
      ].join("\n\n"),
    },
  ],
};

export const campaignPilot = {
  title,
  audience,
  promise,
  description:
    "Um guia curto com exemplos e exercícios para pedir uma correção de código, revisar o patch em uma cópia Git e verificar o resultado antes de aplicar.",
  questions: [
    "Como pedir uma alteração de código que eu consiga revisar?",
    "Como testar uma sugestão de IA sem mexer na minha branch?",
    "O que revisar no diff antes de aplicar a mudança?",
  ],
  answers: [
    "Registre o comportamento atual, o resultado esperado e um teste. Exemplo: nomes só com espaços falham com a mensagem existente, enquanto nomes com acentos continuam válidos.",
    "Use uma worktree a partir de um commit conhecido. Abra a cópia e rode nela um teste que você conhece. Confira depois que a pasta original ficou intacta.",
    "Leia o diff por arquivo, confira se o contrato dos chamadores mudou e rode o teste que cobre o erro e um caso que já funcionava. Guarde o patch e a saída dos testes.",
  ],
  pageUrl: "",
  checkoutUrl: "",
  sampleUrl: "",
  coverUrl: "",
};
